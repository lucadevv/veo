import {
  ApiError,
  createSavedPlace,
  type HttpClient,
  type SavedPlace as SavedPlaceDto,
  savedPlace,
  savedPlaceList,
} from '@veo/api-client';
import type {KeyValueStore} from '../../../core/storage/mmkv';
import {uuidv4} from '../../../shared/utils/uuid';
import type {
  SavedPlace,
  SavedPlaceInput,
  SavedPlaceKind,
} from '../domain/entities';
import type {PlacesRepository} from '../domain/placesRepository';

/**
 * Clave del CACHÉ local (MMKV, prefs) que respalda al repo HTTP. Lo `Mirror` del servidor: la fuente
 * de verdad REAL es el BFF, pero el puerto `PlacesRepository` del dominio es SÍNCRONO (`list(): SavedPlace[]`),
 * así que el caché es lo que se sirve de forma síncrona mientras el HTTP reconcilia en segundo plano.
 */
const CACHE_KEY = 'places.http.cache';

/** Orden de presentación (Casa, Trabajo y al final favoritos), igual que el server-side. */
const KIND_ORDER: Record<SavedPlaceKind, number> = {
  HOME: 0,
  WORK: 1,
  FAVORITE: 2,
};

/**
 * Error de dominio para el tope de favoritos (HTTP 409 RESOURCE_EXHAUSTED del BFF). El puerto es
 * síncrono y la mutación es optimista, así que el 409 llega DESPUÉS del `save`; se reporta por el
 * callback `onReconcileError` para que la presentación lo muestre y se revierte el favorito optimista.
 */
export class PlacesFavoritesLimitError extends Error {
  constructor() {
    super('Alcanzaste el máximo de lugares favoritos.');
    this.name = 'PlacesFavoritesLimitError';
  }
}

/** Reporta el resultado de una reconciliación en segundo plano (refresco del caché / errores). */
export interface PlacesReconcileHooks {
  /** Se llama tras hidratar/reconciliar el caché con el servidor (para que el store refresque). */
  onCacheUpdated?: () => void;
  /** Se llama cuando una mutación de fondo falla de forma NO transitoria (p. ej. 409 tope favoritos). */
  onReconcileError?: (error: Error) => void;
  /**
   * Se llama cuando la hidratación de fondo (GET /places) falla Y NO hay caché que mostrar: la lista
   * quedaría MUDA e indistinguible de "vacío legítimo". La presentación lo usa para pintar el estado de
   * ERROR con reintento (antes el error se tragaba en silencio y no había cómo mostrarlo). Con caché
   * presente NO se llama: se conserva lo cacheado (degradación offline honesta) y se reconcilia luego.
   */
  onLoadError?: (error: Error) => void;
}

/**
 * Repositorio HTTP de Lugares guardados contra el public-bff (`/places`, JwtAuthGuard).
 *
 * ARQUITECTURA — HTTP primario + caché MMKV (read-through / write-through):
 * El puerto `PlacesRepository` del dominio es SÍNCRONO (no se toca el dominio), pero la red es
 * asíncrona. Para reconciliar ambos SIN romper el contrato ni perder el offline que tenía la versión
 * local, el caché MMKV es la copia síncrona que se sirve, y el HTTP la mantiene fresca:
 *  - `list()`  → devuelve el caché YA y dispara un GET de fondo que rehidrata el caché (read-through).
 *  - `save()`/`update()`/`remove()` → aplican el cambio al caché de forma OPTIMISTA (la UI reacciona al
 *    instante) y disparan la mutación HTTP; al éxito reemplazan el optimista por el recurso REAL del
 *    servidor (write-through). Si la red falla de forma transitoria, el caché conserva el optimista
 *    (degradación offline honesta: se sincroniza en el próximo `list()`). Si falla NO transitoriamente
 *    (409 tope de favoritos), se revierte y se reporta por `onReconcileError`.
 *
 * Mapeo BFF↔dominio: el BFF usa coordenadas PLANAS (`lat`/`lng`); el dominio usa `point:{lat,lng}`.
 */
export class HttpSavedPlacesRepository implements PlacesRepository {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: KeyValueStore,
    private hooks: PlacesReconcileHooks = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Cablea los hooks de reconciliación DESPUÉS de construir el repo. El bootstrap (`App`) lo usa para
   * conectar el refresco del store SIN que la composición (registry) importe la capa de presentación
   * (evita el ciclo registry↔store y mantiene la dirección de dependencias limpia).
   */
  setReconcileHooks(hooks: PlacesReconcileHooks): void {
    this.hooks = hooks;
  }

  /** Lee el caché local (copia síncrona del servidor). */
  private readCache(): SavedPlace[] {
    return this.cache.getJSON<SavedPlace[]>(CACHE_KEY) ?? [];
  }

  private writeCache(places: SavedPlace[]): void {
    this.cache.setJSON(CACHE_KEY, places);
  }

  /** Ordena: Casa, Trabajo, favoritos por createdAt descendente (espeja el orden del BFF). */
  private sort(places: SavedPlace[]): SavedPlace[] {
    return [...places].sort((a, b) => {
      const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      return byKind !== 0 ? byKind : b.createdAt.localeCompare(a.createdAt);
    });
  }

  list(): SavedPlace[] {
    // Read-through: sirve el caché YA y rehidrata desde el servidor en segundo plano.
    void this.hydrateFromServer();
    return this.sort(this.readCache());
  }

  save(input: SavedPlaceInput): SavedPlace {
    const optimistic = this.buildOptimistic(input);
    this.writeCache(this.applyLocalSave(this.readCache(), optimistic));
    // Write-through: persiste en el servidor y reemplaza el optimista por el recurso REAL.
    void this.pushSave(input, optimistic);
    return optimistic;
  }

  update(id: string, input: SavedPlaceInput): SavedPlace {
    const current = this.readCache();
    const existing = current.find(p => p.id === id);
    const updated: SavedPlace = {
      id,
      kind: input.kind,
      label: input.label,
      point: input.point,
      createdAt: existing?.createdAt ?? this.now(),
      ...(input.subtitle ? {subtitle: input.subtitle} : {}),
    };
    this.writeCache(current.map(p => (p.id === id ? updated : p)));
    void this.pushUpdate(id, input, updated);
    return updated;
  }

  remove(id: string): void {
    const previous = this.readCache();
    this.writeCache(previous.filter(p => p.id !== id));
    void this.pushRemove(id, previous);
  }

  /* ─────────────────────────── HTTP en segundo plano ─────────────────────────── */

  /** GET /places → rehidrata el caché con la verdad del servidor (read-through). */
  private async hydrateFromServer(): Promise<void> {
    try {
      const dtos = await this.http.get('/places', {schema: savedPlaceList});
      this.writeCache(dtos.map(toDomain));
      this.hooks.onCacheUpdated?.();
    } catch (error) {
      // Degradación offline HONESTA con propagación del error cuando NO hay nada que mostrar:
      //  - Si YA hay caché, la conservamos y NO molestamos al usuario (la lista sigue viva, el próximo
      //    list() reconcilia). El error se traga a propósito acá: es el offline honesto.
      //  - Si el caché está VACÍO y la red/servidor falló, el error DEBE propagarse. Antes se tragaba
      //    en silencio y la lista quedaba muda — indistinguible de "sin lugares guardados". Ahora se
      //    reporta por `onLoadError` para que la pantalla muestre ERROR + reintento (no un falso vacío).
      if (this.readCache().length === 0) {
        this.hooks.onLoadError?.(
          error instanceof Error
            ? error
            : new Error('No se pudieron cargar los lugares'),
        );
      }
    }
  }

  /** POST /places → reemplaza el favorito/único optimista por el recurso real; 409 = tope favoritos. */
  private async pushSave(
    input: SavedPlaceInput,
    optimistic: SavedPlace,
  ): Promise<void> {
    try {
      const dto = await this.http.post('/places', {
        body: toBody(input),
        schema: savedPlace,
      });
      this.replaceOptimistic(optimistic.id, toDomain(dto));
    } catch (error) {
      this.handleMutationError(error, () => this.rollback(optimistic.id));
    }
  }

  /** PUT /places/:id → reemplaza la versión optimista por la confirmada por el servidor. */
  private async pushUpdate(
    id: string,
    input: SavedPlaceInput,
    optimistic: SavedPlace,
  ): Promise<void> {
    try {
      const dto = await this.http.put(`/places/${id}`, {
        body: toBody(input),
        schema: savedPlace,
      });
      this.replaceOptimistic(optimistic.id, toDomain(dto));
    } catch (error) {
      this.handleMutationError(error, () => void this.hydrateFromServer());
    }
  }

  /** DELETE /places/:id (204). Si falla NO transitoriamente, restaura el caché previo. */
  private async pushRemove(id: string, previous: SavedPlace[]): Promise<void> {
    try {
      await this.http.delete(`/places/${id}`);
    } catch (error) {
      this.handleMutationError(error, () => {
        this.writeCache(previous);
        this.hooks.onCacheUpdated?.();
      });
    }
  }

  /** Reemplaza una entrada optimista (por id) por el recurso real del servidor en el caché. */
  private replaceOptimistic(optimisticId: string, real: SavedPlace): void {
    const next = this.readCache().map(p => (p.id === optimisticId ? real : p));
    this.writeCache(next);
    this.hooks.onCacheUpdated?.();
  }

  /** Elimina del caché una entrada optimista que el servidor rechazó. */
  private rollback(optimisticId: string): void {
    this.writeCache(this.readCache().filter(p => p.id !== optimisticId));
    this.hooks.onCacheUpdated?.();
  }

  /**
   * Distingue el error de red TRANSITORIO (se conserva el optimista para sincronizar luego: offline)
   * del error de DOMINIO no transitorio (4xx: se revierte y se reporta). El 409 mapea a tope de favoritos.
   */
  private handleMutationError(error: unknown, revert: () => void): void {
    if (error instanceof ApiError && error.retryable) {
      // Transitorio (red/5xx/429): la versión optimista queda en caché y se reconcilia en el próximo list().
      return;
    }
    revert();
    if (error instanceof ApiError && error.status === 409) {
      this.hooks.onReconcileError?.(new PlacesFavoritesLimitError());
      return;
    }
    this.hooks.onReconcileError?.(
      error instanceof Error ? error : new Error('Error al sincronizar'),
    );
  }

  /** Construye la versión optimista local (id provisional + createdAt local hasta confirmar). */
  private buildOptimistic(input: SavedPlaceInput): SavedPlace {
    return {
      id: uuidv4(),
      kind: input.kind,
      label: input.label,
      point: input.point,
      createdAt: this.now(),
      ...(input.subtitle ? {subtitle: input.subtitle} : {}),
    };
  }

  /** Aplica al caché la semántica de creación: HOME/WORK son únicos (reemplazan); FAVORITE agrega. */
  private applyLocalSave(
    current: SavedPlace[],
    place: SavedPlace,
  ): SavedPlace[] {
    const rest =
      place.kind === 'FAVORITE'
        ? current
        : current.filter(p => p.kind !== place.kind);
    return [...rest, place];
  }
}

/* ─────────────────────────── Mapeo BFF ↔ dominio ─────────────────────────── */

/** BFF (`lat`/`lng` planos, `subtitle` nullable) → dominio (`point:{lat,lng}`, `subtitle?`). */
function toDomain(dto: SavedPlaceDto): SavedPlace {
  return {
    id: dto.id,
    kind: dto.kind,
    label: dto.label,
    point: {lat: dto.lat, lng: dto.lng},
    createdAt: dto.createdAt,
    ...(dto.subtitle ? {subtitle: dto.subtitle} : {}),
  };
}

/** Dominio (`point:{lat,lng}`) → cuerpo del BFF (`lat`/`lng` planos). Validado por `createSavedPlace`. */
function toBody(input: SavedPlaceInput) {
  return createSavedPlace.parse({
    kind: input.kind,
    label: input.label,
    lat: input.point.lat,
    lng: input.point.lng,
    ...(input.subtitle ? {subtitle: input.subtitle} : {}),
  });
}
