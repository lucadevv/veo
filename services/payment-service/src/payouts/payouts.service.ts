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
import { aggregatePayouts, periodLabel, type DriverEarningRow } from './payout.policy';
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
