/**
 * FuelSurchargeService (B3 · B4) — recargo de combustible GLOBAL, editable en caliente. El admin NO ingresa
 * el recargo/km directo: ingresa el PRECIO del combustible (céntimos PEN/litro) + el RENDIMIENTO del vehículo
 * de referencia (km/litro); el servicio DERIVA el recargo/km = precio ÷ rendimiento (deriveFuelPerKmCents).
 * Espeja PricingScheduleService (singleton + version + outbox + cache):
 *  - `getPerKmCents()`: el recargo/km DERIVADO vigente que createTrip/quote suman a la tarifa (0 si no hay fila/caído/rendimiento 0).
 *  - `getConfig()`: GET interno (admin) — precio + rendimiento + perKmCents derivado + version + updatedAt.
 *  - `replace(fuelPricePerLiterCents, kmPerLiter)`: PUT interno — REEMPLAZA precio+rendimiento, bumpea version,
 *    persiste + EMITE fuel.surcharge_updated por outbox en la MISMA transacción (audit + invalidación de cache aguas abajo).
 *
 * Por qué precio÷rendimiento y no un recargo en la fórmula de código: el combustible CAMBIA seguido (el admin
 * ajusta el precio del grifo sin deploy). El motor de tarifa (domain/fare.ts) recibe el perKmCents y lo pliega al per-km.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import { deriveFuelPerKmCents } from '../trips/domain/fare';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import {
  FUEL_SURCHARGE_REPO,
  FUEL_SINGLETON_ID,
  type FuelSurchargeRepository,
  type PersistedFuelSurcharge,
} from './fuel-surcharge.repository';

const PRODUCER = 'trip-service';

/** Token DI del TTL (ms) del cache; lo provee el módulo desde FUEL_SURCHARGE_CACHE_TTL_MS. */
export const FUEL_SURCHARGE_CACHE_TTL_MS = Symbol('FUEL_SURCHARGE_CACHE_TTL_MS');

/** Config + el per-km DERIVADO (lo que exponen GET/PUT): el admin ve precio/rendimiento, el quote usa perKmCents. */
export interface FuelSurchargeView extends PersistedFuelSurcharge {
  perKmCents: number;
}

@Injectable()
export class FuelSurchargeService {
  private readonly logger = new Logger(FuelSurchargeService.name);

  /** Cache in-proc de un slot (singleton, espejo del schedule). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { value: number; expiresAt: number } | null = null;

  constructor(
    @Inject(FUEL_SURCHARGE_REPO) private readonly repo: FuelSurchargeRepository,
    @Optional()
    @Inject(FUEL_SURCHARGE_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /**
   * Recargo de combustible por km vigente (céntimos PEN), DERIVADO = precio_por_litro ÷ rendimiento (B4).
   * Sin fila / rendimiento 0 → 0 (degradación honesta: sin config = sin recargo, NO un crash ni división
   * por cero). Cacheado un slot; el PUT invalida. Los consumidores (quote/create) NO cambian: siguen
   * pidiendo este per-km; solo cambió de dónde sale (de precio+rendimiento en vez de un per-km a mano).
   */
  async getPerKmCents(): Promise<number> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const persisted = await this.repo.find();
    const value = persisted
      ? deriveFuelPerKmCents(persisted.fuelPricePerLiterCents, persisted.kmPerLiter)
      : 0;
    if (this.cacheTtlMs > 0) {
      this.cache = { value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /**
   * GET interno: precio/rendimiento vigentes + el per-km DERIVADO (o 0/0 si no hay fila). El admin ve el
   * precio/rendimiento; el public-bff (quote) consume `perKmCents` (el derivado) — un solo endpoint sirve
   * a ambos sin que el BFF re-implemente la fórmula.
   */
  async getConfig(): Promise<FuelSurchargeView> {
    const persisted = await this.repo.find();
    const cfg = persisted ?? {
      fuelPricePerLiterCents: 0,
      kmPerLiter: 0,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
    return { ...cfg, perKmCents: deriveFuelPerKmCents(cfg.fuelPricePerLiterCents, cfg.kmPerLiter) };
  }

  /**
   * PUT interno: REEMPLAZA precio+rendimiento, bumpea `version` y persiste + EMITE fuel.surcharge_updated
   * por outbox en la MISMA tx (payload incluye el per-km DERIVADO para los consumidores del evento).
   * Idempotente en forma: re-enviar lo mismo deja el mismo estado (sube version).
   */
  async replace(
    fuelPricePerLiterCents: number,
    kmPerLiter: number,
    expectedVersion: number,
  ): Promise<FuelSurchargeView> {
    const nextVersion = expectedVersion + 1;
    const perKmCents = deriveFuelPerKmCents(fuelPricePerLiterCents, kmPerLiter);

    const result = await this.repo.runInTx(async (tx) => {
      // Optimistic locking (CAS): el UPDATE solo pega si la versión vigente sigue siendo `expectedVersion`.
      // El predicado `version` viaja en el WHERE → se evalúa bajo lock al escribir, así dos PUT concurrentes
      // NO pueden ambos bumpear desde la misma versión (el 2º ve count=0 → ConflictError, sin lost update).
      const updated = await tx.fuelSurchargeConfig.updateMany({
        where: { id: FUEL_SINGLETON_ID, version: expectedVersion },
        data: { fuelPricePerLiterCents, kmPerLiter, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        // Releemos para el `updatedAt` autoritativo; la fila existe (la acabamos de actualizar).
        const persisted = await tx.fuelSurchargeConfig.findUnique({
          where: { id: FUEL_SINGLETON_ID },
        });
        if (!persisted)
          throw new ConflictError('el recargo de combustible desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        // Primer write: no debería haber fila. Si OTRO la creó en la carrera → es conflicto, no lost update.
        const existing = await tx.fuelSurchargeConfig.findUnique({
          where: { id: FUEL_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `el recargo de combustible ya fue inicializado (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.fuelSurchargeConfig.create({
          data: { id: FUEL_SINGLETON_ID, fuelPricePerLiterCents, kmPerLiter, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `el recargo de combustible cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      await tx.outboxEvent.create({
        data: {
          aggregateId: FUEL_SINGLETON_ID,
          eventType: 'fuel.surcharge_updated',
          envelope: createEnvelope({
            eventType: 'fuel.surcharge_updated',
            producer: PRODUCER,
            payload: {
              fuelPricePerLiterCents,
              kmPerLiter,
              perKmCents,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    this.invalidateCache(); // el PUT y el getPerKmCents viven en el mismo proceso → el cambio se ve ya
    bumpPricingConfigChanged('fuel_surcharge'); // OPS: señal de cambio de config (FOUNDATION §6)
    this.logger.log(
      `fuel surcharge REEMPLAZADO → version ${result.version} (S/${fuelPricePerLiterCents / 100}/L ÷ ` +
        `${kmPerLiter} km/L = ${perKmCents} céntimos/km); fuel.surcharge_updated emitido; cache invalidado`,
    );
    return {
      fuelPricePerLiterCents,
      kmPerLiter,
      perKmCents,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * PricingCacheConsumer, el evento `fuel.surcharge_updated` que emite el PUT de CUALQUIER réplica
   * → la invalidación es instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }
}
