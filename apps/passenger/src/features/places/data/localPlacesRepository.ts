import type { KeyValueStore } from '../../../core/storage/mmkv';
import { uuidv4 } from '../../../shared/utils/uuid';
import type { SavedPlace, SavedPlaceInput, SavedPlaceKind } from '../domain/entities';
import type { PlacesRepository } from '../domain/placesRepository';

/** Clave de persistencia y tope de favoritos (Casa/Trabajo no cuentan; evita crecer sin límite). */
const KEY = 'places.saved';
const MAX_FAVORITES = 20;

/** Orden de presentación de los tipos (Casa, Trabajo y al final favoritos). */
const KIND_ORDER: Record<SavedPlaceKind, number> = { HOME: 0, WORK: 1, FAVORITE: 2 };

/**
 * Lugares guardados persistidos LOCALMENTE en MMKV (prefs, NO el almacén seguro). Sin red. Casa y
 * Trabajo son únicos (al guardar se reemplaza el previo del mismo tipo); los favoritos se agregan
 * y se ordenan por fecha. Determinista y testeable inyectando un `KeyValueStore` en memoria.
 */
export class LocalPlacesRepository implements PlacesRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private readAll(): SavedPlace[] {
    return this.store.getJSON<SavedPlace[]>(KEY) ?? [];
  }

  private writeAll(places: SavedPlace[]): void {
    this.store.setJSON(KEY, places);
  }

  /** Ordena: Casa, Trabajo, favoritos por createdAt descendente. */
  private sort(places: SavedPlace[]): SavedPlace[] {
    return [...places].sort((a, b) => {
      const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (byKind !== 0) {
        return byKind;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  list(): SavedPlace[] {
    return this.sort(this.readAll());
  }

  save(input: SavedPlaceInput): SavedPlace {
    const current = this.readAll();
    const place: SavedPlace = {
      id: uuidv4(),
      kind: input.kind,
      label: input.label,
      point: input.point,
      createdAt: this.now(),
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    };

    // Casa/Trabajo son únicos: descarta el previo del mismo tipo.
    const rest =
      input.kind === 'FAVORITE'
        ? current
        : current.filter((item) => item.kind !== input.kind);

    // Limita la cantidad de favoritos (los más antiguos se conservan; rechaza el excedente del nuevo).
    const favorites = rest.filter((item) => item.kind === 'FAVORITE');
    if (input.kind === 'FAVORITE' && favorites.length >= MAX_FAVORITES) {
      const oldest = this.sort(favorites).pop();
      const trimmed = oldest ? rest.filter((item) => item.id !== oldest.id) : rest;
      this.writeAll([...trimmed, place]);
      return place;
    }

    this.writeAll([...rest, place]);
    return place;
  }

  update(id: string, input: SavedPlaceInput): SavedPlace {
    const current = this.readAll();
    const existing = current.find((item) => item.id === id);
    if (!existing) {
      // Si no existe, lo creamos (idempotencia amistosa para la UI).
      return this.save(input);
    }
    const updated: SavedPlace = {
      ...existing,
      kind: input.kind,
      label: input.label,
      point: input.point,
      ...(input.subtitle ? { subtitle: input.subtitle } : { subtitle: undefined }),
    };
    this.writeAll(current.map((item) => (item.id === id ? updated : item)));
    return updated;
  }

  remove(id: string): void {
    this.writeAll(this.readAll().filter((item) => item.id !== id));
  }
}
