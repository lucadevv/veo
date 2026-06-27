/**
 * CommissionService (F2.7 · ADR-017 §1.6 / ADR-015 §11.2) — comisión de plataforma por MODO, editable en
 * caliente. Espeja BaseFareService de trip-service (singleton + version CAS + outbox + cache):
 *  - `getOnDemandRateBps()`: la tasa ON-DEMAND vigente en basis points Int (la consume el cobro on-demand).
 *    DEGRADACIÓN HONESTA: si la config no está disponible (DB sin migrar / error transitorio), cae a la tasa
 *    del ENV (`COMMISSION_RATE`, que queda de fallback), NUNCA rompe el cobro ni cae a 0 (eso sería regalar
 *    la comisión on-demand). El cache cubre el camino feliz; el catch cubre el infeliz.
 *  - `getConfig()`: GET vigente (el panel admin) — la tasa bps + version + updatedAt.
 *  - `resolveRateBps(mode)`: el GUARD LEGAL — CARPOOLING → 0 SIEMPRE (constante de dominio), ON_DEMAND → la
 *    tasa configurada. Único punto de resolución por modo.
 *  - `replace(onDemandRateBps, expectedVersion)`: PUT — REEMPLAZA la tasa ON-DEMAND, bumpea `version` (CAS) y
 *    persiste + EMITE payment.commission_updated por outbox en la MISMA tx. NO toca el carpooling (0 fijo legal).
 *  - `invalidateCache()`: lo llama el PUT local y el CommissionCacheConsumer (evento cross-réplica).
 *
 * La tasa SIEMPRE en bps Int (0..10000), JAMÁS float persistido. La división /10000 ocurre al APLICAR
 * (`resolveRateBps` devuelve bps; `bpsToRate` la pliega a 0..1 en el cobro, redondeando a céntimo Int).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import {
  BPS_DENOMINATOR,
  CARPOOLING_COMMISSION_BPS,
  ChargeMode,
  resolveCommissionBps,
} from '../payments/payment.policy';
import type { Env } from '../config/env.schema';
import {
  COMMISSION_REPO,
  COMMISSION_SINGLETON_ID,
  type CommissionRepository,
  type PersistedCommission,
} from './commission.repository';
import { bumpCommissionDegraded } from '../metrics/payment.metrics';

const PRODUCER = 'payment-service';

/** Token DI del TTL (ms) del cache; lo provee el módulo. */
export const COMMISSION_CACHE_TTL_MS = Symbol('COMMISSION_CACHE_TTL_MS');

@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  /** Tasa ON-DEMAND de fallback en bps Int, derivada del env COMMISSION_RATE (float 0..1 → bps). Degradación
   * honesta cuando la config no está disponible: NUNCA 0 (eso regalaría la comisión on-demand). */
  private readonly envFallbackBps: number;

  /** Cache in-proc de un slot (singleton, espejo de base-fare). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { value: PersistedCommission; expiresAt: number } | null = null;

  constructor(
    @Inject(COMMISSION_REPO) private readonly repo: CommissionRepository,
    config: ConfigService<Env, true>,
    @Optional()
    @Inject(COMMISSION_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {
    const envRate = config.getOrThrow<number>('COMMISSION_RATE'); // float 0..1, validado por el env schema
    this.envFallbackBps = Math.round(envRate * BPS_DENOMINATOR);
  }

  /**
   * GET vigente: la tasa ON-DEMAND en bps + version + updatedAt. Sin fila / error → DEGRADACIÓN HONESTA al env
   * (envFallbackBps), version 0. Cacheado un slot; el PUT y el evento cross-réplica lo invalidan. No relanza:
   * el cobro NUNCA debe romperse porque la config no esté disponible.
   */
  async getConfig(): Promise<PersistedCommission> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    let value: PersistedCommission;
    try {
      const persisted = await this.repo.find();
      value = persisted ?? this.envFallback();
    } catch (err) {
      // DB caída / sin migrar: NO rompemos el cobro — caemos a la tasa del env (fallback honesto) y NO
      // cacheamos el fallback (para reintentar la lectura real en la próxima, sin clavarnos en el degradado).
      // Counter alertable: un valor SOSTENIDO = config rota (la tasa aplicada diverge de la del admin), no un
      // blip transitorio. Sin esto, la divergencia config-vs-aplicado en el camino de plata era invisible.
      bumpCommissionDegraded();
      this.logger.warn(
        { err },
        `commission_config no disponible; degradando a la tasa del env (${this.envFallbackBps} bps)`,
      );
      return this.envFallback();
    }
    if (this.cacheTtlMs > 0) {
      this.cache = { value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /** La tasa ON-DEMAND vigente en bps Int (la consume el cobro on-demand · degradación honesta al env). */
  async getOnDemandRateBps(): Promise<number> {
    return (await this.getConfig()).onDemandRateBps;
  }

  /**
   * GUARD LEGAL · resuelve la tasa de comisión (bps Int) para un MODO. CARPOOLING → 0 SIEMPRE (constante de
   * dominio, NO admin-editable, ADR-015 §11.2); ON_DEMAND → la tasa configurada. Único punto de resolución por
   * modo del lado del service (la regla pura vive en `resolveCommissionBps`).
   */
  async resolveRateBps(mode: ChargeMode): Promise<number> {
    if (mode === ChargeMode.CARPOOLING) return CARPOOLING_COMMISSION_BPS;
    return resolveCommissionBps(mode, await this.getOnDemandRateBps());
  }

  /**
   * PUT: REEMPLAZA la tasa ON-DEMAND, bumpea `version` y persiste + EMITE payment.commission_updated por outbox
   * en la MISMA tx. CAS optimista: el UPDATE solo pega si la versión vigente sigue siendo `expectedVersion` (si
   * no, ConflictError 409 → sin lost update). NO admite tocar el carpooling: es 0 fijo legal, no entra acá.
   */
  async replace(onDemandRateBps: number, expectedVersion: number): Promise<PersistedCommission> {
    // Guard de dominio (defensa en profundidad sobre el DTO): bps Int en rango. Cero floats.
    if (!Number.isInteger(onDemandRateBps) || onDemandRateBps < 0 || onDemandRateBps > BPS_DENOMINATOR) {
      throw new ConflictError(
        `la tasa de comisión debe ser un entero en basis points 0..${BPS_DENOMINATOR}`,
      );
    }
    const nextVersion = expectedVersion + 1;

    const result = await this.repo.runInTx(async (tx) => {
      const updated = await tx.commissionConfig.updateMany({
        where: { id: COMMISSION_SINGLETON_ID, version: expectedVersion },
        data: { onDemandRateBps, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        const persisted = await tx.commissionConfig.findUnique({
          where: { id: COMMISSION_SINGLETON_ID },
        });
        if (!persisted) throw new ConflictError('la comisión desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        // Primer write: no debería haber fila. Si OTRO la creó en la carrera → conflicto, no lost update.
        const existing = await tx.commissionConfig.findUnique({
          where: { id: COMMISSION_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `la comisión ya fue inicializada (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.commissionConfig.create({
          data: { id: COMMISSION_SINGLETON_ID, onDemandRateBps, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `la comisión cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      await tx.outboxEvent.create({
        data: {
          aggregateId: COMMISSION_SINGLETON_ID,
          eventType: 'payment.commission_updated',
          envelope: createEnvelope({
            eventType: 'payment.commission_updated',
            producer: PRODUCER,
            payload: {
              onDemandRateBps,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    this.invalidateCache(); // el PUT y el getConfig viven en el mismo proceso → el cambio se ve ya
    this.logger.log(
      `comisión ON-DEMAND REEMPLAZADA → version ${result.version} (${onDemandRateBps} bps = ` +
        `${(onDemandRateBps / BPS_DENOMINATOR) * 100}%); payment.commission_updated emitido; cache invalidado`,
    );
    return {
      onDemandRateBps,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * CommissionCacheConsumer, el evento `payment.commission_updated` que emite el PUT de CUALQUIER réplica
   * → la invalidación es instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /** Snapshot de degradación honesta: la tasa del env, version 0 (no hay config persistida). */
  private envFallback(): PersistedCommission {
    return {
      onDemandRateBps: this.envFallbackBps,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}
