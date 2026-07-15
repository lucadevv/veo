/**
 * CarpoolSearchConfigService (F2) — config SINGLETON del RADIO de búsqueda del carpooling, editable en
 * runtime por el admin. Espejo del DispatchRadiusConfigService de dispatch-service (ADR-021): cache in-proc
 * de UN slot (TTL configurable), GET, PUT que bumpea `version` + persiste + emite `booking.search_radius_
 * config_updated` por OUTBOX en la MISMA tx, e invalida el cache. El repo entra por PUERTO
 * (CARPOOL_SEARCH_CONFIG_REPO) — clean arch: el service no conoce Prisma.
 *
 * El admin edita el radio en KM; la búsqueda geo consume k-rings H3. Este service es el ÚNICO punto que
 * mapea km → k (`kRingForRadiusKm`, dominio puro): guarda km (unidad de negocio) y deriva el k en runtime.
 *  - `getConfig()`      → la config vigente (o el DEFAULT del env si no hay fila), con metadatos de versión.
 *  - `getKRings()`      → { kRing, kRingExpand } derivados — lo que PublishedTripsService consume en la búsqueda.
 *  - `getResolvedRadii()` → radios km + k derivados (para el radar preview: necesita AMBOS).
 *  - `replaceConfig()`  → PUT: reemplaza + bump version + outbox + invalida cache (el cambio se ve sin redeploy).
 *
 * DEGRADACIÓN HONESTA (§8.2): sin fila (DB sin migrar) el service devuelve los defaults SEMBRADOS desde el
 * env (SEARCH_H3_K_RING/_EXPAND → km = k × 0.3) con version 0 — NUNCA rompe la búsqueda porque la config no esté.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ValidationError } from '@veo/utils';
import { kRingForRadiusKm } from '../domain/search-radius';
import { BookingEventType, BOOKING_PRODUCER } from '../events/booking-events';
import {
  CARPOOL_SEARCH_CONFIG_REPO,
  SINGLETON_ID,
  type CarpoolSearchConfigRepository,
  type PersistedSearchConfig,
} from './carpool-search-config.repository';

/** Nombre del evento de outbox del cambio de config (const tipada, NUNCA string suelto · §4-ter). */
export const SEARCH_RADIUS_CONFIG_UPDATED = BookingEventType.SEARCH_RADIUS_CONFIG_UPDATED;

/**
 * Token DI de los DEFAULTS del radio (km), SEMBRADOS desde el env por el módulo (SEARCH_H3_K_RING/_EXPAND →
 * km = k × 0.3km/anillo). Es el rol "env = seed del default de la DB": sin fila el service degrada a ESTO.
 * Sin provider (tests) cae al DEFAULT_SEARCH_RADII.
 */
export const SEARCH_RADIUS_ENV_DEFAULTS = Symbol('SEARCH_RADIUS_ENV_DEFAULTS');

/** Token DI del TTL (ms) del cache de la config; lo provee el módulo. */
export const CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS = Symbol('CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS');

/** Radios (km) de la config. Es lo que el admin edita y lo que se persiste. */
export interface SearchRadii {
  baseRadiusKm: number;
  expandRadiusKm: number;
}

/** Cota de cordura del radio en el DOMINIO (defensa en profundidad sobre el DTO): km base 0..1.5, expand 0.3..2.4. */
const BASE_RADIUS_KM_MIN = 0.0;
const BASE_RADIUS_KM_MAX = 1.5;
const EXPAND_RADIUS_KM_MIN = 0.3;
const EXPAND_RADIUS_KM_MAX = 2.4;

/**
 * DEFAULT tipado (fallback último · tests/sin DI): base=0.3km (k1) / expand=0.6km (k2), equivalente a los
 * defaults env SEARCH_H3_K_RING=1 / _EXPAND=2. En runtime el módulo SIEMBRA estos valores desde el env.
 */
export const DEFAULT_SEARCH_RADII: SearchRadii = { baseRadiusKm: 0.3, expandRadiusKm: 0.6 };

/** k-rings vigentes (lo que el hot-path de la búsqueda geo consume). Mismo shape que SearchH3Config. */
export interface KRings {
  /** k del anillo base (neighbors(celda, kRing)). */
  kRing: number;
  /** k del anillo EXPANDIDO: se reintenta con este si la base da 0 resultados. */
  kRingExpand: number;
}

/** Snapshot resuelto para el radar preview: radios km + los k derivados de cada uno. */
export interface ResolvedRadii extends SearchRadii {
  baseKRing: number;
  expandKRing: number;
}

/**
 * Reader que consume PublishedTripsService (búsqueda + radar). Se inyecta por token (SEARCH_RADIUS_READER)
 * para clean arch: el service de búsqueda depende de esta interfaz, no de la clase concreta. La implementa
 * CarpoolSearchConfigService.
 */
export interface SearchRadiusReader {
  getKRings(): Promise<KRings>;
  getResolvedRadii(): Promise<ResolvedRadii>;
}

/**
 * Token DI del reader del radio (lo consume PublishedTripsService: búsqueda + radar). Inyección por interfaz
 * (clean arch) — el módulo lo cablea a `CarpoolSearchConfigService` con `useExisting`.
 */
export const SEARCH_RADIUS_READER = Symbol('SEARCH_RADIUS_READER');

@Injectable()
export class CarpoolSearchConfigService implements SearchRadiusReader {
  private readonly logger = new Logger(CarpoolSearchConfigService.name);

  /**
   * Cache in-proc de UN solo slot de los radios, espejo del cache del DispatchRadiusConfigService. La búsqueda
   * geo lee `getKRings()` MUY seguido sobre una fila que cambia en el orden de HORAS: el cache absorbe ese path
   * read-heavy. Reglas:
   *  - SOLO se cachean lecturas EXITOSAS (incluido "sin fila" → defaults, respuesta válida).
   *  - `replaceConfig` (PUT) INVALIDA el cache → el cambio surte efecto de inmediato, no tras el TTL.
   *  - Con TTL=0 el cache queda efectivamente deshabilitado (cada lectura expira de inmediato).
   */
  private cache: { radii: SearchRadii; expiresAt: number } | null = null;

  constructor(
    @Inject(CARPOOL_SEARCH_CONFIG_REPO) private readonly repo: CarpoolSearchConfigRepository,
    @Optional()
    @Inject(CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
    @Optional()
    @Inject(SEARCH_RADIUS_ENV_DEFAULTS)
    // Fallback último (tests / sin DI): DEFAULT_SEARCH_RADII. En runtime el módulo inyecta el seed del env.
    private readonly envDefaults: SearchRadii = DEFAULT_SEARCH_RADII,
  ) {}

  /** GET interno: la config vigente (o el DEFAULT del env si no hay fila), con metadatos de versión. */
  async getConfig(): Promise<PersistedSearchConfig> {
    const persisted = await this.repo.find();
    if (persisted) return persisted;
    // Sin fila: DEFAULT explícito (version 0) para que el admin vea el estado real (radios del seed del env).
    return {
      baseRadiusKm: this.envDefaults.baseRadiusKm,
      expandRadiusKm: this.envDefaults.expandRadiusKm,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  /**
   * Radios vigentes (km) para el HOT-PATH, CACHEADOS (1 slot). En miss/vencido lee del repo y cachea solo si
   * la lectura fue exitosa (un throw NO se cachea). Sin fila → defaults del seed del env (degradación honesta).
   * El PUT invalida el cache.
   */
  private async getRadii(): Promise<SearchRadii> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.radii;

    const persisted = await this.repo.find();
    const radii: SearchRadii = persisted
      ? { baseRadiusKm: persisted.baseRadiusKm, expandRadiusKm: persisted.expandRadiusKm }
      : { baseRadiusKm: this.envDefaults.baseRadiusKm, expandRadiusKm: this.envDefaults.expandRadiusKm };

    if (this.cacheTtlMs > 0) {
      this.cache = { radii, expiresAt: now + this.cacheTtlMs };
    }
    return radii;
  }

  /** k-rings vigentes (base + expand) para la búsqueda geo. Mapea los radios km → k en runtime. */
  async getKRings(): Promise<KRings> {
    const { baseRadiusKm, expandRadiusKm } = await this.getRadii();
    return {
      kRing: kRingForRadiusKm(baseRadiusKm),
      kRingExpand: kRingForRadiusKm(expandRadiusKm),
    };
  }

  /** Snapshot resuelto (radios km + k derivados) para el radar preview (necesita AMBAS unidades). */
  async getResolvedRadii(): Promise<ResolvedRadii> {
    const { baseRadiusKm, expandRadiusKm } = await this.getRadii();
    return {
      baseRadiusKm,
      expandRadiusKm,
      baseKRing: kRingForRadiusKm(baseRadiusKm),
      expandKRing: kRingForRadiusKm(expandRadiusKm),
    };
  }

  /**
   * PUT interno: REEMPLAZA la config (radios km), bumpea `version` y persiste + EMITE
   * booking.search_radius_config_updated por outbox en la MISMA transacción (audit + consumidores futuros).
   * Invalida el cache → el cambio se ve en la siguiente búsqueda SIN esperar el TTL. Idempotente en forma:
   * re-enviar el mismo snapshot deja el mismo estado (solo sube la version).
   */
  async replaceConfig(input: SearchRadii): Promise<PersistedSearchConfig> {
    // Guard de dominio (defensa en profundidad sobre el DTO): rangos + expand ≥ base. Un radio fuera de rango
    // o invertido (expand < base) es un estado inválido de config: se rechaza, no se silencia a un default.
    this.assertRadiiInBounds(input);

    const current = await this.repo.find();
    const nextVersion = (current?.version ?? 0) + 1;

    const fields = { baseRadiusKm: input.baseRadiusKm, expandRadiusKm: input.expandRadiusKm };

    const result = await this.repo.runInTx(async (tx) => {
      const row = await tx.carpoolSearchConfig.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...fields, version: nextVersion },
        update: { ...fields, version: nextVersion },
      });
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + consumidores futuros del cambio de config.
      await tx.outboxEvent.create({
        data: {
          aggregateId: SINGLETON_ID,
          eventType: SEARCH_RADIUS_CONFIG_UPDATED,
          envelope: createEnvelope({
            eventType: SEARCH_RADIUS_CONFIG_UPDATED,
            producer: BOOKING_PRODUCER,
            payload: { ...fields, version: row.version, updatedAt: row.updatedAt.toISOString() },
          }),
        },
      });
      return row;
    });

    // INVALIDA el cache: el PUT y el hot-path viven en el MISMO proceso, así que el cambio de config debe
    // verse en la siguiente búsqueda SIN esperar el TTL (sino tardaría hasta `cacheTtlMs`).
    this.cache = null;

    this.logger.log(
      `carpool search config REEMPLAZADO → version ${result.version} ` +
        `(baseRadiusKm ${input.baseRadiusKm} → k${kRingForRadiusKm(input.baseRadiusKm)}, ` +
        `expandRadiusKm ${input.expandRadiusKm} → k${kRingForRadiusKm(input.expandRadiusKm)}); ` +
        `${SEARCH_RADIUS_CONFIG_UPDATED} emitido; cache invalidado`,
    );
    return { ...fields, version: result.version, updatedAt: result.updatedAt.toISOString() };
  }

  /**
   * Guard de dominio del radio (defensa en profundidad sobre el DTO). Rangos: base 0..1.5km, expand 0.3..2.4km.
   * Invariante cross-field: expand ≥ base (un radio expandido MENOR que el base no tiene sentido — la búsqueda
   * expande a un anillo más grande, nunca más chico). Fuera de rango / invertido → ValidationError tipado.
   */
  private assertRadiiInBounds(input: SearchRadii): void {
    if (input.baseRadiusKm < BASE_RADIUS_KM_MIN || input.baseRadiusKm > BASE_RADIUS_KM_MAX) {
      throw new ValidationError(
        `baseRadiusKm debe estar entre ${BASE_RADIUS_KM_MIN} y ${BASE_RADIUS_KM_MAX} km`,
        { baseRadiusKm: input.baseRadiusKm },
      );
    }
    if (input.expandRadiusKm < EXPAND_RADIUS_KM_MIN || input.expandRadiusKm > EXPAND_RADIUS_KM_MAX) {
      throw new ValidationError(
        `expandRadiusKm debe estar entre ${EXPAND_RADIUS_KM_MIN} y ${EXPAND_RADIUS_KM_MAX} km`,
        { expandRadiusKm: input.expandRadiusKm },
      );
    }
    if (input.expandRadiusKm < input.baseRadiusKm) {
      throw new ValidationError('expandRadiusKm debe ser ≥ baseRadiusKm', {
        baseRadiusKm: input.baseRadiusKm,
        expandRadiusKm: input.expandRadiusKm,
      });
    }
  }
}
