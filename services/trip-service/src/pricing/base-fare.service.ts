/**
 * BaseFareService (F2.4) — tarifa base GLOBAL editable en caliente: banderazo + per-km + per-min, los tres
 * componentes base de la fórmula de tarifa que antes vivían HARDCODEADOS en domain/fare.ts
 * (BASE_FARE_CENTS/PER_KM_CENTS/PER_MIN_CENTS). Espeja FuelSurchargeService (singleton + version + outbox +
 * cache):
 *  - `getConfig()`: GET vigente (admin + el quote del public-bff) — los tres céntimos + version + updatedAt.
 *    Sin fila (DB sin migrar) → los DEFAULTS del código (600/120/30): degradación honesta hacia el
 *    comportamiento ACTUAL, NUNCA hacia S/0 (eso sería "viajes gratis", el footgun opuesto al de fuel).
 *  - `replace(baseFareCents, perKmCents, perMinCents, expectedVersion)`: PUT — REEMPLAZA los tres, bumpea
 *    `version` (CAS optimista) y persiste + EMITE pricing.base_fare_updated por outbox en la MISMA tx.
 *  - `invalidateCache()`: lo llama el PUT local y el PricingCacheConsumer (evento cross-réplica).
 *
 * NO calcula la tarifa: solo CONFIGURA los componentes. El motor (domain/fare.ts) los recibe como parámetros
 * y los pliega al cálculo — ese threading lo hace el orquestador aparte (F2.4 solo construye la config).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import { BASE_FARE_CENTS, PER_KM_CENTS, PER_MIN_CENTS } from '../trips/domain/fare';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import {
  BASE_FARE_REPO,
  BASE_FARE_SINGLETON_ID,
  type BaseFareRepository,
  type PersistedBaseFare,
} from './base-fare.repository';

const PRODUCER = 'trip-service';

/** Token DI del TTL (ms) del cache; lo provee el módulo (reusa el TTL del schedule, sin env nuevo). */
export const BASE_FARE_CACHE_TTL_MS = Symbol('BASE_FARE_CACHE_TTL_MS');

/** Default del código = los valores hardcodeados vigentes (single source: domain/fare.ts). */
const DEFAULT_BASE_FARE: PersistedBaseFare = {
  baseFareCents: BASE_FARE_CENTS,
  perKmCents: PER_KM_CENTS,
  perMinCents: PER_MIN_CENTS,
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

@Injectable()
export class BaseFareService {
  private readonly logger = new Logger(BaseFareService.name);

  /** Cache in-proc de un slot (singleton, espejo del fuel-surcharge). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { value: PersistedBaseFare; expiresAt: number } | null = null;

  constructor(
    @Inject(BASE_FARE_REPO) private readonly repo: BaseFareRepository,
    @Optional()
    @Inject(BASE_FARE_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /**
   * GET vigente: los tres componentes base + version + updatedAt. Sin fila → los DEFAULTS del código
   * (comportamiento actual, NO S/0). Cacheado un slot; el PUT y el evento cross-réplica lo invalidan.
   */
  async getConfig(): Promise<PersistedBaseFare> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const persisted = await this.repo.find();
    const value = persisted ?? DEFAULT_BASE_FARE;
    if (this.cacheTtlMs > 0) {
      this.cache = { value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /**
   * PUT: REEMPLAZA los tres componentes, bumpea `version` y persiste + EMITE pricing.base_fare_updated por
   * outbox en la MISMA tx. CAS optimista: el UPDATE solo pega si la versión vigente sigue siendo
   * `expectedVersion` (si no, ConflictError 409 → sin lost update). Idempotente en forma: re-enviar lo mismo
   * deja el mismo estado (sube version).
   */
  async replace(
    baseFareCents: number,
    perKmCents: number,
    perMinCents: number,
    expectedVersion: number,
  ): Promise<PersistedBaseFare> {
    const nextVersion = expectedVersion + 1;

    const result = await this.repo.runInTx(async (tx) => {
      // Optimistic locking (CAS): el predicado `version` viaja en el WHERE → se evalúa bajo lock al escribir,
      // así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0 → 409).
      const updated = await tx.baseFareConfig.updateMany({
        where: { id: BASE_FARE_SINGLETON_ID, version: expectedVersion },
        data: { baseFareCents, perKmCents, perMinCents, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        // Releemos para el `updatedAt` autoritativo; la fila existe (la acabamos de actualizar).
        const persisted = await tx.baseFareConfig.findUnique({
          where: { id: BASE_FARE_SINGLETON_ID },
        });
        if (!persisted)
          throw new ConflictError('la tarifa base desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        // Primer write: no debería haber fila. Si OTRO la creó en la carrera → es conflicto, no lost update.
        const existing = await tx.baseFareConfig.findUnique({
          where: { id: BASE_FARE_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `la tarifa base ya fue inicializada (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.baseFareConfig.create({
          data: { id: BASE_FARE_SINGLETON_ID, baseFareCents, perKmCents, perMinCents, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `la tarifa base cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      await tx.outboxEvent.create({
        data: {
          aggregateId: BASE_FARE_SINGLETON_ID,
          eventType: 'pricing.base_fare_updated',
          envelope: createEnvelope({
            eventType: 'pricing.base_fare_updated',
            producer: PRODUCER,
            payload: {
              baseFareCents,
              perKmCents,
              perMinCents,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    this.invalidateCache(); // el PUT y el getConfig viven en el mismo proceso → el cambio se ve ya
    bumpPricingConfigChanged('base_fare'); // OPS: señal de cambio de config (FOUNDATION §6)
    this.logger.log(
      `tarifa base REEMPLAZADA → version ${result.version} (banderazo S/${baseFareCents / 100} · ` +
        `S/${perKmCents / 100}/km · S/${perMinCents / 100}/min); pricing.base_fare_updated emitido; cache invalidado`,
    );
    return {
      baseFareCents,
      perKmCents,
      perMinCents,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * PricingCacheConsumer, el evento `pricing.base_fare_updated` que emite el PUT de CUALQUIER réplica
   * → la invalidación es instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }
}
