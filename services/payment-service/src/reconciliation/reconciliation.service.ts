/**
 * ReconciliationService — conciliación diaria (BR-P07) + red de seguridad de reembolsos (S5 · BR-P06).
 * Cron 04:00: compara lo capturado en DB (Yape/Plin) contra el extracto del gateway (vía puerto;
 * el adapter sandbox entrega un extracto determinista). Discrepancia > umbral → alerta a finanzas.
 * Cron horario: barre Refunds PENDING más viejos que el umbral (REFUND_PENDING_ALERT_MIN) y ALERTA a
 * ops con datos accionables — el lazo callback/uid puede tener agujeros operativos (callback perdido,
 * timeout de /reverse/new sin uid) y un Refund PENDING eterno es plata del pasajero en el limbo.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { uuidv7, withDistributedLock, ValidationError } from '@veo/utils';
import { ReconciliationRepository } from './reconciliation.repository';
import { REDIS } from '../infra/redis';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/gateway/payment-gateway.port';
import { type ReconciliationRun } from '../generated/prisma';
import { discrepancyPct } from '../payouts/payout.policy';
import type { Env } from '../config/env.schema';

const CRON_LOCK_KEY = 'veo:payment:lock:daily-reconciliation';
const CRON_LOCK_TTL_SECONDS = 600;

const REFUND_SWEEP_LOCK_KEY = 'veo:payment:lock:stale-refund-sweep';
const REFUND_SWEEP_LOCK_TTL_SECONDS = 300;
/** Tope de refunds DETALLADOS por barrido (cota de volumen de logs); el total real va en el resumen. */
const REFUND_SWEEP_DETAIL_LIMIT = 50;

const CASH_SWEEP_LOCK_KEY = 'veo:payment:lock:stale-cash-sweep';
const CASH_SWEEP_LOCK_TTL_SECONDS = 300;
/** Tope de pagos en efectivo DETALLADOS por barrido (cota de logs); el total real va en el resumen. */
const CASH_SWEEP_DETAIL_LIMIT = 50;

export interface ReconciliationResult {
  ranAt: string;
  dbTotalCents: number;
  statementTotalCents: number;
  discrepancyPct: number;
  alerted: boolean;
}

const RECON_DEFAULT_LIMIT = 30;
const RECON_MAX_LIMIT = 100;
function clampReconLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECON_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), RECON_MAX_LIMIT);
}

export interface ReconciliationRunPage {
  items: ReconciliationRun[];
  nextCursor: string | null;
}

export interface StaleRefundSweepResult {
  ranAt: string;
  /** Refunds PENDING más viejos que el umbral (total real, no acotado por el límite de detalle). */
  staleCount: number;
  alerted: boolean;
}

export interface StaleCashSweepResult {
  ranAt: string;
  /** Pagos en efectivo PENDING más viejos que el umbral (total real, no acotado por el límite de detalle). */
  staleCount: number;
  alerted: boolean;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly alertPct: number;
  private readonly refundPendingAlertMin: number;
  private readonly cashPendingAlertMin: number;

  constructor(
    private readonly repo: ReconciliationRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    config: ConfigService<Env, true>,
  ) {
    this.alertPct = config.getOrThrow<number>('RECONCILIATION_ALERT_PCT');
    this.refundPendingAlertMin = config.getOrThrow<number>('REFUND_PENDING_ALERT_MIN');
    this.cashPendingAlertMin = config.getOrThrow<number>('CASH_PENDING_ALERT_MIN');
  }

  /** Cron diario 04:00 (hora del servidor). Concilia el día previo. Lock distribuido: corre UNA réplica. */
  @Cron('0 4 * * *')
  async dailyCron(): Promise<void> {
    await withDistributedLock(this.redis, CRON_LOCK_KEY, CRON_LOCK_TTL_SECONDS, async () => {
      const { start, end } = previousDay(new Date());
      await this.reconcile(start, end);
    });
  }

  /** Cron horario (minuto 15): red de seguridad de Refunds PENDING viejos. Lock propio (multi-pod). */
  @Cron('15 * * * *')
  async staleRefundCron(): Promise<void> {
    await withDistributedLock(
      this.redis,
      REFUND_SWEEP_LOCK_KEY,
      REFUND_SWEEP_LOCK_TTL_SECONDS,
      async () => {
        await this.sweepStalePendingRefunds(new Date());
      },
    );
  }

  /** Cron horario (minuto 30): red de seguridad de pagos en EFECTIVO PENDING viejos (el conductor
   * cobró en mano pero el pasajero nunca confirmó). Lock propio (multi-pod). */
  @Cron('30 * * * *')
  async staleCashCron(): Promise<void> {
    await withDistributedLock(
      this.redis,
      CASH_SWEEP_LOCK_KEY,
      CASH_SWEEP_LOCK_TTL_SECONDS,
      async () => {
        await this.sweepStaleCashPending(new Date());
      },
    );
  }

  /**
   * Barrido de Refunds PENDING más viejos que el umbral (red de seguridad PROMETIDA del lazo S5):
   * un reverso digital queda PENDING esperando el callback del proveedor; si el callback se pierde
   * (red, deploy, NO_MATCH agotado) o el timeout de /reverse/new dejó el Refund sin uid, NADIE lo
   * cerraría. Este barrido lo hace VISIBLE para ops con datos accionables.
   *
   * SOLO ALERTA, NADA de updates a mano silenciosos: el puerto PaymentGateway no expone consulta de
   * estado del REVERSO (PaymentStatusQuery consulta COBROS por uid; ProntoPaga no documenta un GET de
   * reverso), así que no hay cierre automático HONESTO posible — marcar COMPLETED/REJECTED sin
   * confirmación del proveedor sería inventar el destino de la plata. Si el proveedor expone la
   * consulta algún día, se agrega la capacidad al puerto (ISP) y este barrido la usa para cerrar por
   * el MISMO camino idempotente del callback (applyRefundWebhookResult).
   */
  async sweepStalePendingRefunds(now: Date): Promise<StaleRefundSweepResult> {
    const threshold = new Date(now.getTime() - this.refundPendingAlertMin * 60_000);

    const staleCount = await this.repo.countStalePendingRefunds(threshold);
    if (staleCount === 0) {
      this.logger.log(
        `Barrido de reembolsos PENDING: sin refunds más viejos que ${this.refundPendingAlertMin}min`,
      );
      return { ranAt: now.toISOString(), staleCount: 0, alerted: false };
    }

    const stale = await this.repo.findStalePendingRefunds(threshold, REFUND_SWEEP_DETAIL_LIMIT);

    for (const r of stale) {
      const ageMin = Math.floor((now.getTime() - r.createdAt.getTime()) / 60_000);
      // uid presente → el proveedor ACEPTÓ el reverso y el callback no llegó/no correlacionó (reclamar
      // a soporte del proveedor con ese uid). uid NULL → /reverse/new quedó sin respuesta (timeout §4):
      // verificar con el proveedor si el reverso existe ANTES de re-lanzarlo (no soporta idempotencia).
      this.logger.error(
        `ALERTA REEMBOLSO PENDIENTE VIEJO: refund=${r.id} pago=${r.paymentId} monto=${r.amountCents}c ` +
          `uid=${r.externalRefundId ?? 'SIN_UID(timeout_de_reverso)'} solicitadoPor=${r.requestedBy} ` +
          `edad=${ageMin}min (umbral ${this.refundPendingAlertMin}min): el callback del proveedor no lo cerró; ` +
          `requiere intervención de ops (sin cierre automático: el gateway no expone consulta de reverso)`,
      );
    }
    this.logger.error(
      `ALERTA REEMBOLSOS PENDING: ${staleCount} refund(s) más viejos que ${this.refundPendingAlertMin}min ` +
        `(detallados ${stale.length}/${staleCount})`,
    );
    return { ranAt: now.toISOString(), staleCount, alerted: true };
  }

  /**
   * Barrido de pagos en EFECTIVO PENDING más viejos que el umbral (red de seguridad gemela del lazo de
   * refunds). Un cobro en efectivo queda PENDING tras driverConfirmed esperando la confirmación del
   * pasajero (payment.cash_pending → push); si el pasajero NUNCA confirma, el Payment quedaba PENDING
   * para siempre — plata cobrada en la calle, invisible al sistema. Este barrido lo hace VISIBLE a ops.
   *
   * SOLO ALERTA, igual que el sweep de refunds: capturar sin la confirmación del pasajero invertiría el
   * doble-OK (anti-fraude del conductor); marcar DEBT/CAPTURED es una decisión de negocio que ops resuelve
   * con estos datos accionables, no un cierre automático silencioso.
   */
  async sweepStaleCashPending(now: Date): Promise<StaleCashSweepResult> {
    const threshold = new Date(now.getTime() - this.cashPendingAlertMin * 60_000);

    const staleCount = await this.repo.countStaleCashPending(threshold);
    if (staleCount === 0) {
      this.logger.log(
        `Barrido de efectivo PENDING: sin pagos más viejos que ${this.cashPendingAlertMin}min`,
      );
      return { ranAt: now.toISOString(), staleCount: 0, alerted: false };
    }

    const stale = await this.repo.findStaleCashPending(threshold, CASH_SWEEP_DETAIL_LIMIT);

    for (const p of stale) {
      const ageMin = Math.floor((now.getTime() - p.createdAt.getTime()) / 60_000);
      this.logger.error(
        `ALERTA EFECTIVO PENDIENTE VIEJO: pago=${p.id} viaje=${p.tripId} monto=${p.amountCents}c ` +
          `conductor=${p.driverId ?? 'SIN_CONDUCTOR'} pasajero=${p.passengerId ?? 'SIN_PASAJERO'} ` +
          `edad=${ageMin}min (umbral ${this.cashPendingAlertMin}min): el conductor cobró pero el pasajero ` +
          `no confirmó; requiere intervención de ops (sin cierre automático: capturar sin el OK del ` +
          `pasajero rompería el anti-fraude bilateral)`,
      );
    }
    this.logger.error(
      `ALERTA EFECTIVO PENDING: ${staleCount} pago(s) más viejos que ${this.cashPendingAlertMin}min ` +
        `(detallados ${stale.length}/${staleCount})`,
    );
    return { ranAt: now.toISOString(), staleCount, alerted: true };
  }

  async reconcile(start: Date, end: Date): Promise<ReconciliationResult> {
    // Solo rieles externos (Yape/Plin); el efectivo no aparece en extractos del gateway. Se SUMA en la DB (no
    // materializar todos los cobros del día en memoria para reducir en JS — coherente con AnalyticsService que ya
    // agrega). El repo hace el COALESCE POR-FILA (`net_settled_cents ?? amount_cents`) vía raw SQL. P-B (ADR-022):
    // el lado DB es el NETO esperado en el banco (net_settled = bruto − fee PSP), NO el bruto (antes divergía por
    // el fee acumulado); legacy (net_settled NULL) cae al bruto por fila. Usa el índice [method, status, capturedAt].
    const { dbTotalCents, dbCount } = await this.repo.sumCapturedDigitalSettlement(start, end);

    const statement = await this.gateway.getStatement(start, end);
    const statementTotalCents = statement.reduce((sum, e) => sum + e.amountCents, 0);

    const pct = discrepancyPct(dbTotalCents, statementTotalCents);
    const alerted = pct > this.alertPct;

    await this.repo.createReconciliationRun({
      id: uuidv7(),
      discrepancyPct: pct,
      alerted,
      details: {
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        dbTotalCents,
        statementTotalCents,
        dbCount,
        statementCount: statement.length,
      },
    });

    if (alerted) {
      // Alerta a finanzas (log estructurado; un colector/alerta de obs lo escala).
      this.logger.error(
        `ALERTA CONCILIACIÓN: discrepancia ${(pct * 100).toFixed(2)}% (DB ${dbTotalCents} vs extracto ${statementTotalCents}) supera umbral ${(this.alertPct * 100).toFixed(2)}%`,
      );
    } else {
      this.logger.log(`Conciliación OK: discrepancia ${(pct * 100).toFixed(2)}%`);
    }

    return {
      ranAt: new Date().toISOString(),
      dbTotalCents,
      statementTotalCents,
      discrepancyPct: pct,
      alerted,
    };
  }

  /**
   * Historial paginado de corridas de conciliación (BR-P07) para el panel FINANCE. Orden cronológico
   * descendente por id (uuidv7 ⇒ monotónico temporal, mismo criterio que `listAll` de payouts). El detalle rico
   * (montos DB vs extracto + conteos) viaja en `details` Json; el admin-bff lo aplana a una view tipada.
   */
  async listRuns(opts: { cursor?: string; limit?: number }): Promise<ReconciliationRunPage> {
    const limit = clampReconLimit(opts.limit);
    const rows = await this.repo.listReconciliationRuns({ cursor: opts.cursor, take: limit + 1 });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.id : null };
  }
}

/** Día previo [00:00, 00:00) respecto a `now` (UTC). */
export function previousDay(now: Date): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 1);
  return { start, end };
}

/**
 * Ventana [00:00, 00:00) UTC de un día `YYYY-MM-DD` (para el trigger dev de la conciliación). Valida el
 * formato y que sea una fecha real (rechaza 2026-13-40); el resto de la validación de forma la hace el DTO.
 */
export function dayWindowUtc(date: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new ValidationError(`Fecha inválida (esperado YYYY-MM-DD): ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(Date.UTC(y, mo - 1, d));
  if (
    start.getUTCFullYear() !== y ||
    start.getUTCMonth() !== mo - 1 ||
    start.getUTCDate() !== d
  ) {
    throw new ValidationError(`Fecha inexistente: ${date}`);
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
}
