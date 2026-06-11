/**
 * PayoutsService — liquidación semanal por conductor (BR-P05).
 * Cron lunes: agrega los cobros capturados de la semana previa, aplica mínimo liquidable y
 * retención (HELD) si el conductor está en review (señal driver.flagged). Publica payout.processed.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { ForbiddenError, uuidv7 } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { aggregatePayouts, assertPayoutTransition, periodLabel, type DriverEarningRow } from './payout.policy';
import { Prisma, PayoutStatus, type Payout } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const FLAGGED_DRIVERS_KEY = 'veo:payment:flagged-drivers';
const CRON_LOCK_KEY = 'veo:payment:lock:weekly-payouts';
const CRON_LOCK_TTL_SECONDS = 600;
const STEPUP_MAX_AGE_SECONDS = 300;

export interface PayoutRunSummary {
  periodStart: string;
  periodEnd: string;
  processed: number;
  held: number;
  totalAmountCents: number;
}

/** Resultado de liberar la retención de un conductor (camino de vuelta de driver.flagged). */
export interface ReleaseHeldPayoutsResult {
  driverId: string;
  /** Payouts HELD→PROCESSED liberados por esta llamada (0 si ya estaban liberados: idempotente). */
  released: number;
  totalAmountCents: number;
}

/** Página con cursor (id uuidv7) para el listado admin de payouts. */
export interface PayoutPage {
  items: Payout[];
  nextCursor: string | null;
}
const PAYOUTS_DEFAULT_LIMIT = 25;
const PAYOUTS_MAX_LIMIT = 100;
function clampPayoutLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAYOUTS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), PAYOUTS_MAX_LIMIT);
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly minCents: number;
  private readonly stepUpCents: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.minCents = config.getOrThrow<number>('PAYOUT_MIN_CENTS');
    this.stepUpCents = config.getOrThrow<number>('PAYOUT_STEPUP_CENTS');
  }

  /** Cron semanal: lunes 06:00 (hora del servidor). Liquida la semana previa [lun, lun). */
  @Cron('0 6 * * 1')
  async weeklyCron(): Promise<void> {
    // Lock distribuido: solo una instancia corre el cron.
    const acquired = await this.redis.set(CRON_LOCK_KEY, '1', 'EX', CRON_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return;
    const { start, end } = previousWeek(new Date());
    try {
      const summary = await this.runPayouts(start, end);
      this.logger.log(`Payouts semanales: ${summary.processed} pagados, ${summary.held} retenidos`);
    } catch (err) {
      this.logger.error({ err }, 'Cron de payouts falló');
    }
  }

  /**
   * Corre la liquidación para un período. Idempotente por conductor+período (UNIQUE).
   * Si el operador la dispara manualmente y el total supera S/5000, exige step-up MFA fresco (BR-S07).
   */
  async runPayouts(start: Date, end: Date, operator?: AuthenticatedUser): Promise<PayoutRunSummary> {
    const rows = await this.collectEarnings(start, end);
    const aggregated = aggregatePayouts(rows, this.minCents);
    const projectedTotal = aggregated.reduce((sum, p) => sum + p.amountCents, 0);

    if (operator && projectedTotal > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Liquidación por ${projectedTotal} céntimos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }

    const label = periodLabel(start, end);
    let processed = 0;
    let held = 0;
    let totalAmountCents = 0;

    for (const agg of aggregated) {
      const existing = await this.prisma.read.payout.findUnique({
        where: { driverId_periodStart_periodEnd: { driverId: agg.driverId, periodStart: start, periodEnd: end } },
      });
      if (existing) continue; // idempotencia: ya liquidado este período.

      const flagged = (await this.redis.sismember(FLAGGED_DRIVERS_KEY, agg.driverId)) === 1;
      await this.prisma.write.$transaction(async (tx) => {
        const payout = await tx.payout.create({
          data: {
            id: uuidv7(),
            driverId: agg.driverId,
            periodStart: start,
            periodEnd: end,
            grossCents: agg.grossCents,
            commissionCents: agg.commissionCents,
            amountCents: agg.amountCents,
            status: flagged ? 'HELD' : 'PROCESSED',
            heldReason: flagged ? 'driver_in_review' : null,
            processedAt: flagged ? null : new Date(),
          },
        });
        if (!flagged) {
          const envelope = createEnvelope({
            eventType: 'payout.processed',
            producer: 'payment-service',
            payload: {
              payoutId: payout.id,
              driverId: payout.driverId,
              amountCents: payout.amountCents,
              period: label,
            },
          });
          await enqueueOutbox(tx, envelope, payout.id);
        }
      });

      if (flagged) {
        held += 1;
      } else {
        processed += 1;
        totalAmountCents += agg.amountCents;
      }
    }

    return { periodStart: start.toISOString(), periodEnd: end.toISOString(), processed, held, totalAmountCents };
  }

  listByDriver(driverId: string): Promise<unknown[]> {
    return this.prisma.read.payout.findMany({
      where: { driverId },
      orderBy: { periodStart: 'desc' },
    });
  }

  /**
   * Listado paginado de TODOS los payouts para el operador (admin/finance), filtrable por estado.
   * Paginación cursor por id (uuidv7 ⇒ orden temporal estable). Separado de listByDriver (anti-IDOR
   * del conductor): este lo gatea el controller con RBAC FINANCE/ADMIN, no es por-dueño.
   */
  async listAll(opts: { status?: PayoutStatus; cursor?: string; limit?: number }): Promise<PayoutPage> {
    const limit = clampPayoutLimit(opts.limit);
    const where: Prisma.PayoutWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.payout.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  /** Retención de payouts del conductor en review (consumido desde driver.flagged). */
  async holdDriver(driverId: string): Promise<void> {
    await this.redis.sadd(FLAGGED_DRIVERS_KEY, driverId);
  }

  /**
   * Camino de VUELTA de driver.flagged (review resuelto, acción admin): libera los payouts HELD del
   * conductor (transición tipada HELD→PROCESSED) y levanta su retención (srem del set de flaggeados,
   * para que las próximas liquidaciones no nazcan HELD).
   *
   *  - Los payouts se liberan en UNA transacción; cada liberación emite `payout.processed` por OUTBOX
   *    en la MISMA tx (idéntico dominó que el cron para un payout no retenido: la plata sale y
   *    notification-service avisa). El CAS `updateMany where status=HELD` hace la operación idempotente
   *    y concurrencia-segura: una liberación re-entrante libera 0 y NO re-emite.
   *  - El srem va DESPUÉS de la tx: si liberar falla, el conductor sigue retenido (estado consistente)
   *    y el operador reintenta; el reintento es seguro.
   *  - Plata grande exige step-up MFA fresco, espejo de runPayouts (BR-S07).
   *  - `heldReason` se conserva (historia de POR QUÉ estuvo retenido); el estado vigente es PROCESSED.
   *  - El audit trail del operador lo registra admin-bff (AuditRecorder, action payout.release_held),
   *    como hace con payout.run; acá queda el rastro de dominio (outbox + log estructurado).
   */
  async releaseHeldPayouts(driverId: string, operator?: AuthenticatedUser): Promise<ReleaseHeldPayoutsResult> {
    const held = await this.prisma.read.payout.findMany({
      where: { driverId, status: PayoutStatus.HELD },
      orderBy: { periodStart: 'asc' },
    });
    const projectedTotal = held.reduce((sum, p) => sum + p.amountCents, 0);

    if (operator && projectedTotal > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Liberar ${projectedTotal} céntimos retenidos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }

    let released = 0;
    let totalAmountCents = 0;
    await this.prisma.write.$transaction(async (tx) => {
      for (const payout of held) {
        assertPayoutTransition(payout.status, PayoutStatus.PROCESSED);
        const { count } = await tx.payout.updateMany({
          where: { id: payout.id, status: PayoutStatus.HELD },
          data: { status: PayoutStatus.PROCESSED, processedAt: new Date() },
        });
        if (count === 0) continue; // otra liberación concurrente ya lo procesó: no re-emitir.
        const envelope = createEnvelope({
          eventType: 'payout.processed',
          producer: 'payment-service',
          payload: {
            payoutId: payout.id,
            driverId: payout.driverId,
            amountCents: payout.amountCents,
            period: periodLabel(payout.periodStart, payout.periodEnd),
          },
        });
        await enqueueOutbox(tx, envelope, payout.id);
        released += 1;
        totalAmountCents += payout.amountCents;
      }
    });

    // Des-flag al final: las próximas liquidaciones del conductor ya no nacen HELD. Idempotente.
    await this.redis.srem(FLAGGED_DRIVERS_KEY, driverId);

    this.logger.log(
      `Retención liberada para el conductor ${driverId}: ${released} payout(s) HELD→PROCESSED ` +
        `por ${totalAmountCents} céntimos${operator ? ` (operador ${operator.userId})` : ''}`,
    );
    return { driverId, released, totalAmountCents };
  }

  private async collectEarnings(start: Date, end: Date): Promise<DriverEarningRow[]> {
    const payments = await this.prisma.read.payment.findMany({
      where: {
        // Incluye PARTIALLY_REFUNDED (F4): un reembolso PARCIAL al pasajero lo absorbe la plataforma
        // (sale de su comisión); el conductor prestó el servicio → mantiene su neto. Un cobro REFUNDED
        // (total) sí queda fuera (viaje revertido → el conductor no cobra).
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        driverId: { not: null },
        capturedAt: { gte: start, lt: end },
      },
      select: { driverId: true, grossCents: true, commissionCents: true, tipCents: true },
    });
    const earningRows: DriverEarningRow[] = payments
      .filter((p): p is { driverId: string; grossCents: number; commissionCents: number; tipCents: number } =>
        p.driverId !== null,
      )
      .map((p) => ({
        driverId: p.driverId,
        grossCents: p.grossCents,
        commissionCents: p.commissionCents,
        tipCents: p.tipCents,
      }));

    // F2.3 · Compensación por penalidades de cancelación SALDADAS en el período: el conductor que esperó
    // cobra su parte del split cuando el pasajero paga. Se acredita NETA (sin comisión, no es bruto de
    // viaje). La ventana es por `collectedAt` (cuándo se saldó), no por la cancelación. driverId not null
    // y comp > 0 (una penalidad sin conductor va entera a la plataforma → no acredita a nadie).
    const penalties = await this.prisma.read.cancellationPenalty.findMany({
      where: {
        status: 'COLLECTED',
        driverId: { not: null },
        collectedAt: { gte: start, lt: end },
      },
      select: { driverId: true, driverCompensationCents: true },
    });
    const compensationRows: DriverEarningRow[] = penalties
      .filter((p): p is { driverId: string; driverCompensationCents: number } =>
        p.driverId !== null && p.driverCompensationCents > 0,
      )
      .map((p) => ({
        driverId: p.driverId,
        grossCents: 0,
        commissionCents: 0,
        tipCents: 0,
        compensationCents: p.driverCompensationCents,
      }));

    return [...earningRows, ...compensationRows];
  }

  private hasFreshMfa(user: AuthenticatedUser): boolean {
    if (!user.mfaVerifiedAt) return false;
    const ageSeconds = Math.floor(Date.now() / 1000) - user.mfaVerifiedAt;
    return ageSeconds <= STEPUP_MAX_AGE_SECONDS;
  }
}

/** Semana previa [lunes 00:00, lunes 00:00) respecto a `now` (UTC). */
export function previousWeek(now: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=domingo..6=sábado
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  return { start: lastMonday, end: thisMonday };
}
