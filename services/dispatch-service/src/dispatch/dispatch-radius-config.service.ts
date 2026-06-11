/**
 * DispatchRadiusConfigService — config SINGLETON de RADIOS de dispatch (k-rings) editable en runtime por
 * el admin. Espejo EXACTO del PricingScheduleService del trip-service (ADR 011): cache in-proc de UN slot
 * (TTL configurable), GET, PUT que bumpea `version` + persiste + emite outbox en la MISMA tx, e invalida
 * el cache. El repo entra por PUERTO (DISPATCH_RADIUS_CONFIG_REPO) — clean arch: el service no conoce Prisma.
 *
 * Consumidores del hot-path (NearbyDriversService feed de mapa, OfferBoardService broadcast de pujas) leen
 * los k-rings vía `getKRings()` (cacheado) en runtime, sin reiniciar el servicio al cambiar el radio.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import {
  DISPATCH_RADIUS_CONFIG_REPO,
  SINGLETON_ID,
  type DispatchRadiusConfigRepository,
  type PersistedRadiusConfig,
} from './dispatch-radius-config.repository';

const PRODUCER = 'dispatch-service';

/** Nombre del evento de outbox del cambio de config (const tipada, NUNCA string suelto · §4-ter). */
export const DISPATCH_RADIUS_CONFIG_UPDATED = 'dispatch.radius_config_updated' as const;

/**
 * DEFAULTS tipados (degradación honesta §8.2): sin fila el service devuelve ESTO con version 0, no crash.
 * `nearbyKRing=3` (feed de mapa) y `matchKRing=4` (broadcast de pujas). NO son magic numbers sueltos.
 */
export const DEFAULT_RADIUS_CONFIG = { nearbyKRing: 3, matchKRing: 4 } as const;

/** k-rings vigentes (lo que el hot-path consume). */
export interface KRings {
  nearbyKRing: number;
  matchKRing: number;
}

/** Token DI del TTL (ms) del cache de la config; lo provee el módulo. */
export const DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS = Symbol('DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS');

@Injectable()
export class DispatchRadiusConfigService {
  private readonly logger = new Logger(DispatchRadiusConfigService.name);

  /**
   * Cache in-proc de UN solo slot de los k-rings (espejo del cache del PricingScheduleService). El
   * hot-path (feed de mapa + broadcast de pujas) lee `getKRings()` MUY seguido sobre una fila que cambia
   * en el orden de HORAS: el cache absorbe ese path read-heavy. Reglas:
   *  - SOLO se cachean lecturas EXITOSAS (incluido "sin fila" → DEFAULT_RADIUS_CONFIG, respuesta válida).
   *  - `replaceConfig` (PUT) INVALIDA el cache → el cambio surte efecto de inmediato, no tras el TTL.
   *  - Con TTL=0 el cache queda efectivamente deshabilitado (cada lectura expira de inmediato).
   */
  private cache: { kRings: KRings; expiresAt: number } | null = null;

  constructor(
    @Inject(DISPATCH_RADIUS_CONFIG_REPO) private readonly repo: DispatchRadiusConfigRepository,
    @Optional()
    @Inject(DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /** GET interno: la config vigente (o el DEFAULT explícito si no hay fila), con metadatos de versión. */
  async getConfig(): Promise<PersistedRadiusConfig> {
    const persisted = await this.repo.find();
    if (persisted) return persisted;
    // Sin fila: DEFAULT explícito (version 0) para que el admin vea el estado real.
    return { ...DEFAULT_RADIUS_CONFIG, version: 0, updatedAt: new Date(0).toISOString() };
  }

  /**
   * k-rings vigentes para el HOT-PATH (feed de mapa + broadcast de pujas), CACHEADOS (1 slot). En miss/
   * vencido lee del repo y cachea solo si la lectura fue exitosa (un throw NO se cachea). Sin fila →
   * DEFAULT_RADIUS_CONFIG (degradación honesta). El PUT invalida el cache.
   */
  async getKRings(): Promise<KRings> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.kRings;

    const persisted = await this.repo.find();
    const kRings: KRings = persisted
      ? { nearbyKRing: persisted.nearbyKRing, matchKRing: persisted.matchKRing }
      : { ...DEFAULT_RADIUS_CONFIG };

    if (this.cacheTtlMs > 0) {
      this.cache = { kRings, expiresAt: now + this.cacheTtlMs };
    }
    return kRings;
  }

  /**
   * PUT interno: REEMPLAZA la config (nearbyKRing + matchKRing), bumpea `version` y persiste + EMITE
   * dispatch.radius_config_updated por outbox en la MISMA transacción (audit + consumidores futuros).
   * Invalida el cache → el cambio se ve en el siguiente getKRings SIN esperar el TTL. Idempotente en
   * forma: re-enviar el mismo snapshot deja el mismo estado (solo sube la version).
   */
  async replaceConfig(input: KRings): Promise<PersistedRadiusConfig> {
    const current = await this.repo.find();
    const nextVersion = (current?.version ?? 0) + 1;

    const result = await this.repo.runInTx(async (tx) => {
      const row = await tx.dispatchRadiusConfig.upsert({
        where: { id: SINGLETON_ID },
        create: {
          id: SINGLETON_ID,
          nearbyKRing: input.nearbyKRing,
          matchKRing: input.matchKRing,
          version: nextVersion,
        },
        update: {
          nearbyKRing: input.nearbyKRing,
          matchKRing: input.matchKRing,
          version: nextVersion,
        },
      });
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + consumidores futuros del cambio de radios.
      await tx.outboxEvent.create({
        data: {
          aggregateId: SINGLETON_ID,
          eventType: DISPATCH_RADIUS_CONFIG_UPDATED,
          envelope: createEnvelope({
            eventType: DISPATCH_RADIUS_CONFIG_UPDATED,
            producer: PRODUCER,
            payload: {
              nearbyKRing: input.nearbyKRing,
              matchKRing: input.matchKRing,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    // INVALIDA el cache: el PUT y el hot-path viven en el MISMO proceso, así que un cambio de radio debe
    // verse en el siguiente getKRings SIN esperar el TTL (sino tardaría hasta `cacheTtlMs`).
    this.cache = null;

    this.logger.log(
      `dispatch radius config REEMPLAZADO → version ${result.version} ` +
        `(nearbyKRing ${input.nearbyKRing}, matchKRing ${input.matchKRing}); ` +
        `${DISPATCH_RADIUS_CONFIG_UPDATED} emitido; cache invalidado`,
    );
    return {
      nearbyKRing: input.nearbyKRing,
      matchKRing: input.matchKRing,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }
}
