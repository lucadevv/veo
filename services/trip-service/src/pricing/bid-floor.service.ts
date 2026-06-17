/**
 * BidFloorService (ADR 010 §9.3) — piso de la PUJA editable en caliente, keyed por (zona, oferta). Espeja
 * FuelSurchargeService/PricingScheduleService (singleton + version + CAS + outbox + cache):
 *  - `resolve(zone, offeringId)`: el piso AUTORITATIVO que createTrip/rebid usan como gate del bid. Delega
 *    en `resolveBidFloorCents` (PURO, @veo/shared-types) — el MISMO resolver que el public-bff usa para el
 *    display del quote, así quote↔create no divergen.
 *  - `getConfig()`: GET interno (admin) — defaultFloorCents + overrides + version + updatedAt.
 *  - `replace(...)`: PUT interno — REEMPLAZA wholesale (default + overrides), bumpea version, persiste +
 *    EMITE pricing.bid_floor_updated por outbox en la MISMA transacción (audit + invalidación de cache).
 *
 * Reemplaza el escalar global hardcodeado en env (BID_FLOOR_CENTS): ahora el piso es config que el admin
 * maneja sin deploy, con piso por defecto + overrides por oferta (per-oferta hoy; per-zona no-breaking).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import {
  DEFAULT_BID_FLOOR_CONFIG,
  resolveBidFloorCents,
  type BidFloorConfig,
  type BidFloorOverride,
  type OfferingId,
  type PricingZoneKey,
} from '@veo/shared-types';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import {
  BID_FLOOR_REPO,
  BID_FLOOR_SINGLETON_ID,
  type BidFloorRepository,
  type PersistedBidFloor,
} from './bid-floor.repository';

const PRODUCER = 'trip-service';

/** Token DI del TTL (ms) del cache; lo provee el módulo desde BID_FLOOR_CACHE_TTL_MS (reusa el del schedule). */
export const BID_FLOOR_CACHE_TTL_MS = Symbol('BID_FLOOR_CACHE_TTL_MS');

@Injectable()
export class BidFloorService {
  private readonly logger = new Logger(BidFloorService.name);

  /** Cache in-proc de un slot (singleton, espejo del schedule/fuel). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { config: BidFloorConfig; expiresAt: number } | null = null;

  constructor(
    @Inject(BID_FLOOR_REPO) private readonly repo: BidFloorRepository,
    @Optional()
    @Inject(BID_FLOOR_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /**
   * Piso AUTORITATIVO del bid para (zona, oferta) en céntimos PEN. Carga la config (cacheada) y delega en el
   * resolver PURO. Sin fila → DEFAULT_BID_FLOOR_CONFIG (piso S/7, sin overrides) = comportamiento previo
   * (degradación honesta). El PUT invalida el cache → un cambio de piso se ve en el siguiente resolve.
   */
  async resolve(zone: PricingZoneKey, offeringId: OfferingId): Promise<number> {
    const config = await this.loadConfig();
    return resolveBidFloorCents(config, zone, offeringId);
  }

  /** GET interno: la config vigente + metadatos de versión (o el DEFAULT explícito si no hay fila). */
  async getConfig(): Promise<PersistedBidFloor> {
    const persisted = await this.repo.find();
    if (persisted) return persisted;
    // Sin fila: devolvemos el DEFAULT explícito (version 0) para que el admin vea el estado real.
    return { ...DEFAULT_BID_FLOOR_CONFIG, version: 0, updatedAt: new Date(0).toISOString() };
  }

  /**
   * PUT interno: REEMPLAZA wholesale la config (defaultFloorCents + overrides), bumpea `version` y persiste +
   * EMITE pricing.bid_floor_updated por outbox en la MISMA tx. Idempotente en forma: re-enviar lo mismo deja
   * el mismo estado (sube version). El CAS optimista (version en el WHERE) evita el lost-update concurrente.
   */
  async replace(input: {
    defaultFloorCents: number;
    overrides: BidFloorOverride[];
    expectedVersion: number;
  }): Promise<PersistedBidFloor> {
    const nextVersion = input.expectedVersion + 1;
    // Serializamos los overrides tal cual (ya validados por el DTO) como JSON de la fila.
    const overridesJson = input.overrides.map((o) => ({
      zone: o.zone,
      offeringId: o.offeringId,
      floorCents: o.floorCents,
    }));

    const result = await this.repo.runInTx(async (tx) => {
      const data = {
        defaultFloorCents: input.defaultFloorCents,
        overrides: overridesJson,
        version: nextVersion,
      };
      // Optimistic locking (CAS): el UPDATE solo pega si la versión vigente sigue siendo `expectedVersion`
      // (predicado bajo lock) → dos PUT concurrentes no se pisan (el 2º ve count=0 → 409, sin lost update).
      const updated = await tx.bidFloorConfig.updateMany({
        where: { id: BID_FLOOR_SINGLETON_ID, version: input.expectedVersion },
        data,
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        const persisted = await tx.bidFloorConfig.findUnique({
          where: { id: BID_FLOOR_SINGLETON_ID },
        });
        if (!persisted) throw new ConflictError('el piso de puja desapareció durante el reemplazo');
        row = persisted;
      } else if (input.expectedVersion === 0) {
        const existing = await tx.bidFloorConfig.findUnique({
          where: { id: BID_FLOOR_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `el piso de puja ya fue inicializado (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.bidFloorConfig.create({ data: { id: BID_FLOOR_SINGLETON_ID, ...data } });
      } else {
        throw new ConflictError(
          `el piso de puja cambió (esperabas v${input.expectedVersion}); recargá y reintentá`,
        );
      }
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + invalidación de cache cross-réplica (PricingCacheConsumer).
      await tx.outboxEvent.create({
        data: {
          aggregateId: BID_FLOOR_SINGLETON_ID,
          eventType: 'pricing.bid_floor_updated',
          envelope: createEnvelope({
            eventType: 'pricing.bid_floor_updated',
            producer: PRODUCER,
            payload: {
              defaultFloorCents: input.defaultFloorCents,
              overrides: overridesJson,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    // El PUT y el resolve viven en el MISMO proceso → un cambio de piso debe verse en el siguiente resolve
    // SIN esperar el TTL (sino tardaría hasta `cacheTtlMs`).
    this.invalidateCache();
    bumpPricingConfigChanged('bid_floor'); // OPS: señal de cambio de config (FOUNDATION §6)

    this.logger.log(
      `bid floor REEMPLAZADO → version ${result.version} (default ${input.defaultFloorCents} céntimos, ` +
        `${input.overrides.length} override(s)); pricing.bid_floor_updated emitido; cache invalidado`,
    );
    return {
      defaultFloorCents: input.defaultFloorCents,
      overrides: input.overrides,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * PricingCacheConsumer, el evento `pricing.bid_floor_updated` que emite el PUT de CUALQUIER réplica
   * → la invalidación es instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Carga la config del repo o el DEFAULT (piso S/7, sin overrides) si no hay fila (degradación honesta).
   * Sirve del cache de UN slot si no venció; en miss/vencido lee del repo y CACHEA solo si la lectura fue
   * exitosa (un throw del repo NO se cachea: propaga). El PUT invalida el cache.
   */
  private async loadConfig(): Promise<BidFloorConfig> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.config;

    const persisted = await this.repo.find();
    const config: BidFloorConfig = persisted
      ? { defaultFloorCents: persisted.defaultFloorCents, overrides: persisted.overrides }
      : DEFAULT_BID_FLOOR_CONFIG;

    if (this.cacheTtlMs > 0) {
      this.cache = { config, expiresAt: now + this.cacheTtlMs };
    }
    return config;
  }
}
