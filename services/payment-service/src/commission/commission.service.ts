/**
 * CommissionService (F2.7 · ADR-017 §1.6 / ADR-015 §11.2) — comisión de plataforma por MODO, editable en
 * caliente. Espeja BaseFareService de trip-service (singleton + version CAS + outbox + cache):
 *  - `getOnDemandRateBps()`: la tasa ON-DEMAND vigente en basis points Int (la consume el cobro on-demand).
 *    DEGRADACIÓN HONESTA: si la config no está disponible (DB sin migrar / error transitorio), cae a la tasa
 *    del ENV (`COMMISSION_RATE`, que queda de fallback), NUNCA rompe el cobro ni cae a 0 (eso sería regalar
 *    la comisión on-demand). El cache cubre el camino feliz; el catch cubre el infeliz.
 *  - `getConfig()`: GET vigente (el panel admin) — la tasa bps + version + updatedAt.
 *  - `resolveRateBps(mode)`: CARPOOLING → `carpoolingFeeBps` (service fee al pasajero), ON_DEMAND → `onDemandRateBps`
 *    (comisión al conductor). Único punto de resolución por modo.
 *  - `replaceOnDemandRate(onDemandRateBps, expectedVersion)`: PUT — edita SOLO la comisión on-demand, CAS sobre
 *    `version`. `replaceCarpoolingFee(carpoolingFeeBps, expectedVersion)`: PUT — edita SOLO el service fee de
 *    carpooling, CAS sobre `carpoolingFeeVersion` (INDEPENDIENTE). Cada panel su CAS → editar uno NO 409ea al
 *    otro. Ambos persisten + EMITEN payment.commission_updated por outbox en la MISMA tx.
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
  ChargeMode,
  resolveCommissionBps,
  resolvePspFeeBps as policyResolvePspFeeBps,
  type PspFeeRatesBps,
} from '../payments/payment.policy';
import type { PaymentMethod } from '@veo/shared-types';
import type { Env } from '../config/env.schema';
import {
  COMMISSION_REPO,
  COMMISSION_SINGLETON_ID,
  type CommissionRepository,
  type CommissionRow,
  type CommissionTx,
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
   * Resuelve la tasa de comisión (bps Int) para un MODO. ON_DEMAND → `onDemandRateBps` (descontada al conductor);
   * CARPOOLING → `carpoolingFeeBps` (service fee al pasajero). Ambas de la config vigente (con degradación honesta:
   * on-demand al env, carpooling a 0). Único punto de resolución por modo del lado del service (la regla pura vive
   * en `resolveCommissionBps`).
   */
  async resolveRateBps(mode: ChargeMode): Promise<number> {
    return resolveCommissionBps(mode, await this.getConfig());
  }

  /**
   * P-B (ADR-022) · Resuelve el fee del PSP (bps Int) para un método de pago, desde la config vigente (editable por
   * admin, degradación honesta a 0 si no está seteado o la config no está disponible). CASH → 0 (no pasa por el PSP).
   * Lo consume la captura para computar el neto REAL que llega al banco (`Payment.netSettledCents`).
   */
  async resolvePspFeeBps(method: PaymentMethod): Promise<number> {
    const c = await this.getConfig();
    return policyResolvePspFeeBps(method, {
      yapeFeeBps: c.yapeFeeBps ?? 0,
      plinFeeBps: c.plinFeeBps ?? 0,
      cardFeeBps: c.cardFeeBps ?? 0,
      pagoefectivoFeeBps: c.pagoefectivoFeeBps ?? 0,
    });
  }

  /**
   * PUT: edita SOLO la comisión ON-DEMAND, bumpea `version` (CAS) y persiste + EMITE payment.commission_updated
   * por outbox en la MISMA tx. CAS optimista sobre `version`: el UPDATE solo pega si la versión vigente sigue
   * siendo `expectedVersion` (si no, ConflictError 409 → sin lost update). NO toca `carpoolingFeeBps` ni su
   * `carpoolingFeeVersion` (los preserva) → editar la comisión on-demand ya no 409ea el panel de carpooling.
   */
  async replaceOnDemandRate(
    onDemandRateBps: number,
    expectedVersion: number,
  ): Promise<PersistedCommission> {
    // Guard de dominio (defensa en profundidad sobre el DTO): la tasa bps Int en rango. Cero floats.
    assertBps(onDemandRateBps, 'la comisión on-demand');
    const nextVersion = expectedVersion + 1;

    const result = await this.repo.runInTx(async (tx) => {
      const updated = await tx.commissionConfig.updateMany({
        where: { id: COMMISSION_SINGLETON_ID, version: expectedVersion },
        data: { onDemandRateBps, version: nextVersion },
      });

      let row: CommissionRow;
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
        // Init: carpooling arranca en 0 con su propia version en 0; PSP fees por defecto 0.
        row = await tx.commissionConfig.create({
          data: {
            id: COMMISSION_SINGLETON_ID,
            onDemandRateBps,
            carpoolingFeeBps: 0,
            version: nextVersion,
            carpoolingFeeVersion: 0,
          },
        });
      } else {
        throw new ConflictError(
          `la comisión cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      await this.emitCommissionUpdated(tx, row);
      return row;
    });

    this.invalidateCache(); // el PUT y el getConfig viven en el mismo proceso → el cambio se ve ya
    this.logger.log(
      `comisión ON-DEMAND reemplazada → version ${result.version} (${onDemandRateBps} bps); ` +
        `payment.commission_updated emitido; cache invalidado`,
    );
    return this.toView(result);
  }

  /**
   * PUT: edita SOLO el service fee de CARPOOLING, bumpea `carpoolingFeeVersion` (CAS INDEPENDIENTE) y persiste +
   * EMITE payment.commission_updated por outbox en la MISMA tx. CAS optimista sobre `carpoolingFeeVersion`: el
   * UPDATE solo pega si la version vigente de carpooling sigue siendo `expectedVersion` (si no, 409 → sin lost
   * update). NO toca `onDemandRateBps` ni `version` (los preserva) → editar el carpooling ya no 409ea el panel
   * on-demand.
   */
  async replaceCarpoolingFee(
    carpoolingFeeBps: number,
    expectedVersion: number,
  ): Promise<PersistedCommission> {
    assertBps(carpoolingFeeBps, 'el service fee de carpooling');
    const nextCarpoolingVersion = expectedVersion + 1;

    const result = await this.repo.runInTx(async (tx) => {
      const updated = await tx.commissionConfig.updateMany({
        where: { id: COMMISSION_SINGLETON_ID, carpoolingFeeVersion: expectedVersion },
        data: { carpoolingFeeBps, carpoolingFeeVersion: nextCarpoolingVersion },
      });

      let row: CommissionRow;
      if (updated.count === 1) {
        const persisted = await tx.commissionConfig.findUnique({
          where: { id: COMMISSION_SINGLETON_ID },
        });
        if (!persisted) throw new ConflictError('la comisión desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        // carpoolingFeeVersion 0 esperado y el updateMany no pegó → o no hay fila (init), o la fila tiene una
        // carpoolingFeeVersion distinta de 0 (otro ya la movió → conflicto). Distinguimos releyendo.
        const existing = await tx.commissionConfig.findUnique({
          where: { id: COMMISSION_SINGLETON_ID },
        });
        if (existing) {
          // La fila existe pero su carpoolingFeeVersion no era 0 (si lo fuera, el updateMany habría pegado).
          throw new ConflictError(
            `el service fee de carpooling ya fue inicializado (v${existing.carpoolingFeeVersion}); recargá y reintentá`,
          );
        }
        // Init sin fila (DB fresca/tests): on-demand al fallback del env, su version en 0; carpooling con su
        // fee + carpoolingFeeVersion 1; PSP fees por defecto 0.
        row = await tx.commissionConfig.create({
          data: {
            id: COMMISSION_SINGLETON_ID,
            onDemandRateBps: this.envFallbackBps,
            carpoolingFeeBps,
            version: 0,
            carpoolingFeeVersion: nextCarpoolingVersion,
          },
        });
      } else {
        throw new ConflictError(
          `el service fee de carpooling cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      await this.emitCommissionUpdated(tx, row);
      return row;
    });

    this.invalidateCache();
    this.logger.log(
      `service fee CARPOOLING reemplazado → carpoolingFeeVersion ${result.carpoolingFeeVersion} ` +
        `(${carpoolingFeeBps} bps); payment.commission_updated emitido; cache invalidado`,
    );
    return this.toView(result);
  }

  /**
   * P-B (ADR-022) · PUT que EDITA el fee del PSP por método (yape/plin/card/pagoefectivo), en bps Int. El dueño
   * carga la tarifa REAL del convenio acá (arranca en 0). Full-replace de los 4 fees con CAS optimista sobre
   * `version` (dos PUT concurrentes NO bumpean desde la misma versión). Invalida el cache LOCAL; la propagación
   * cross-réplica cae al TTL del cache (10s) — aceptable para un cambio de config (no es el hot-path del cobro,
   * que ya persistió su fee en la captura). NO emite outbox (a diferencia de los PUT de comisión): el fee ya no
   * cambia cobros pasados (están persistidos), y el TTL cubre los futuros dentro de 10s.
   */
  async replacePspFees(rates: PspFeeRatesBps, expectedVersion: number): Promise<PersistedCommission> {
    assertBps(rates.yapeFeeBps, 'el fee PSP de Yape');
    assertBps(rates.plinFeeBps, 'el fee PSP de Plin');
    assertBps(rates.cardFeeBps, 'el fee PSP de tarjeta');
    assertBps(rates.pagoefectivoFeeBps, 'el fee PSP de PagoEfectivo');
    const nextVersion = expectedVersion + 1;
    const data = {
      yapeFeeBps: rates.yapeFeeBps,
      plinFeeBps: rates.plinFeeBps,
      cardFeeBps: rates.cardFeeBps,
      pagoefectivoFeeBps: rates.pagoefectivoFeeBps,
      version: nextVersion,
    };
    // Base del retorno LEÍDA ANTES del write (read-your-writes): el retorno se construye del snapshot vigente +
    // los fees nuevos, NO re-leyendo la RÉPLICA post-write (que puede lagear el commit del primary y devolver stale).
    const current = await this.getConfig();

    await this.repo.runInTx(async (tx) => {
      const updated = await tx.commissionConfig.updateMany({
        where: { id: COMMISSION_SINGLETON_ID, version: expectedVersion },
        data,
      });
      if (updated.count === 1) return;
      if (expectedVersion === 0) {
        const existing = await tx.commissionConfig.findUnique({
          where: { id: COMMISSION_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `la config ya fue inicializada (v${existing.version}); recargá y reintentá`,
          );
        }
        // Primer write sin fila (DB fresca/tests): crear con los fees PSP + los defaults de comisión.
        await tx.commissionConfig.create({
          data: { id: COMMISSION_SINGLETON_ID, onDemandRateBps: this.envFallbackBps, carpoolingFeeBps: 0, ...data },
        });
        return;
      }
      throw new ConflictError(`la config cambió (esperabas v${expectedVersion}); recargá y reintentá`);
    });

    this.invalidateCache();
    this.logger.log(
      `fee PSP REEMPLAZADO → version ${nextVersion} (yape ${rates.yapeFeeBps}, plin ${rates.plinFeeBps}, ` +
        `card ${rates.cardFeeBps}, pagoefectivo ${rates.pagoefectivoFeeBps} bps); cache local invalidado`,
    );
    // Retorno read-your-writes: el snapshot previo + los fees nuevos + la nueva version (NO re-lee la réplica).
    return {
      ...current,
      yapeFeeBps: rates.yapeFeeBps,
      plinFeeBps: rates.plinFeeBps,
      cardFeeBps: rates.cardFeeBps,
      pagoefectivoFeeBps: rates.pagoefectivoFeeBps,
      version: nextVersion,
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

  /** Snapshot de degradación honesta: on-demand a la tasa del env, carpooling-fee a 0 (sin fee), ambas versions 0. */
  private envFallback(): PersistedCommission {
    return {
      onDemandRateBps: this.envFallbackBps,
      carpoolingFeeBps: 0,
      version: 0,
      carpoolingFeeVersion: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  /**
   * Emite payment.commission_updated por outbox EN LA MISMA tx del PUT. El payload es el snapshot VIGENTE (ambas
   * tasas + ambas versions, leídas de la fila resultante): el consumer solo invalida cache, pero el payload es
   * fiel para cualquier otro observador. Compartido por los dos PUT de comisión (on-demand y carpooling).
   */
  private async emitCommissionUpdated(tx: CommissionTx, row: CommissionRow): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateId: COMMISSION_SINGLETON_ID,
        eventType: 'payment.commission_updated',
        envelope: createEnvelope({
          eventType: 'payment.commission_updated',
          producer: PRODUCER,
          payload: {
            onDemandRateBps: row.onDemandRateBps,
            carpoolingFeeBps: row.carpoolingFeeBps,
            version: row.version,
            carpoolingFeeVersion: row.carpoolingFeeVersion,
            updatedAt: row.updatedAt.toISOString(),
          },
        }),
      },
    });
  }

  /** Proyecta la fila resultante de un PUT al contrato PersistedCommission (retorno del service · read-your-writes). */
  private toView(row: CommissionRow): PersistedCommission {
    return {
      onDemandRateBps: row.onDemandRateBps,
      carpoolingFeeBps: row.carpoolingFeeBps,
      version: row.version,
      carpoolingFeeVersion: row.carpoolingFeeVersion,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Guard de dominio compartido: una tasa de comisión es un entero en basis points 0..10000. Cero floats. */
function assertBps(bps: number, label: string): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new ConflictError(`${label} debe ser un entero en basis points 0..${BPS_DENOMINATOR}`);
  }
}
