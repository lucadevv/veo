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
import { uuidv7, withDistributedLock } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/gateway/payment-gateway.port';
import { RefundStatus } from '../generated/prisma';
import { discrepancyPct } from '../payouts/payout.policy';
import type { Env } from '../config/env.schema';

const CRON_LOCK_KEY = 'veo:payment:lock:daily-reconciliation';
const CRON_LOCK_TTL_SECONDS = 600;

const REFUND_SWEEP_LOCK_KEY = 'veo:payment:lock:stale-refund-sweep';
const REFUND_SWEEP_LOCK_TTL_SECONDS = 300;
/** Tope de refunds DETALLADOS por barrido (cota de volumen de logs); el total real va en el resumen. */
const REFUND_SWEEP_DETAIL_LIMIT = 50;

export interface ReconciliationResult {
  ranAt: string;
  dbTotalCents: number;
  statementTotalCents: number;
  discrepancyPct: number;
  alerted: boolean;
}

export interface StaleRefundSweepResult {
  ranAt: string;
  /** Refunds PENDING más viejos que el umbral (total real, no acotado por el límite de detalle). */
  staleCount: number;
  alerted: boolean;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly alertPct: number;
  private readonly refundPendingAlertMin: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    config: ConfigService<Env, true>,
  ) {
    this.alertPct = config.getOrThrow<number>('RECONCILIATION_ALERT_PCT');
    this.refundPendingAlertMin = config.getOrThrow<number>('REFUND_PENDING_ALERT_MIN');
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
    await withDistributedLock(this.redis, REFUND_SWEEP_LOCK_KEY, REFUND_SWEEP_LOCK_TTL_SECONDS, async () => {
      await this.sweepStalePendingRefunds(new Date());
    });
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
    const where = { status: RefundStatus.PENDING, createdAt: { lt: threshold } };

    const staleCount = await this.prisma.read.refund.count({ where });
    if (staleCount === 0) {
      this.logger.log(`Barrido de reembolsos PENDING: sin refunds más viejos que ${this.refundPendingAlertMin}min`);
      return { ranAt: now.toISOString(), staleCount: 0, alerted: false };
    }

    const stale = await this.prisma.read.refund.findMany({
      where,
      select: {
        id: true,
        paymentId: true,
        amountCents: true,
        externalRefundId: true,
        requestedBy: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: REFUND_SWEEP_DETAIL_LIMIT,
    });

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

  async reconcile(start: Date, end: Date): Promise<ReconciliationResult> {
    // Solo rieles externos (Yape/Plin); el efectivo no aparece en extractos del gateway.
    const captured = await this.prisma.read.payment.findMany({
      where: {
        status: 'CAPTURED',
        method: { in: ['YAPE', 'PLIN'] },
        capturedAt: { gte: start, lt: end },
      },
      select: { amountCents: true },
    });
    const dbTotalCents = captured.reduce((sum, p) => sum + p.amountCents, 0);

    const statement = await this.gateway.getStatement(start, end);
    const statementTotalCents = statement.reduce((sum, e) => sum + e.amountCents, 0);

    const pct = discrepancyPct(dbTotalCents, statementTotalCents);
    const alerted = pct > this.alertPct;

    await this.prisma.write.reconciliationRun.create({
      data: {
        id: uuidv7(),
        discrepancyPct: pct,
        alerted,
        details: {
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          dbTotalCents,
          statementTotalCents,
          dbCount: captured.length,
          statementCount: statement.length,
        },
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
}

/** Día previo [00:00, 00:00) respecto a `now` (UTC). */
export function previousDay(now: Date): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 1);
  return { start, end };
}
