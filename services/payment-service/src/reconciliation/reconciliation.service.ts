/**
 * ReconciliationService — conciliación diaria (BR-P07).
 * Cron 04:00: compara lo capturado en DB (Yape/Plin) contra el extracto del gateway (vía puerto;
 * el adapter sandbox entrega un extracto determinista). Discrepancia > umbral → alerta a finanzas.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/gateway/payment-gateway.port';
import { discrepancyPct } from '../payouts/payout.policy';
import type { Env } from '../config/env.schema';

const CRON_LOCK_KEY = 'veo:payment:lock:daily-reconciliation';
const CRON_LOCK_TTL_SECONDS = 600;

export interface ReconciliationResult {
  ranAt: string;
  dbTotalCents: number;
  statementTotalCents: number;
  discrepancyPct: number;
  alerted: boolean;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly alertPct: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    config: ConfigService<Env, true>,
  ) {
    this.alertPct = config.getOrThrow<number>('RECONCILIATION_ALERT_PCT');
  }

  /** Cron diario 04:00 (hora del servidor). Concilia el día previo. */
  @Cron('0 4 * * *')
  async dailyCron(): Promise<void> {
    const acquired = await this.redis.set(CRON_LOCK_KEY, '1', 'EX', CRON_LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return;
    const { start, end } = previousDay(new Date());
    await this.reconcile(start, end);
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
