/**
 * AnalyticsRepository — ÚNICO punto de acceso Prisma de los KPIs de recaudación (schema 'payment'). Es
 * SOLO-LECTURA (dashboard admin): todas las lecturas van a la RÉPLICA (`prisma.read`). Espeja
 * `commission.repository.ts` (acceso simple repo-owned) — sin transacciones, sin outbox: agrega HECHOS de dinero
 * PROPIOS de payment-service (sin joins cross-servicio · CLAUDE §2).
 *
 * CRISTALIZA el COHORTE de "money-in al banco" (P-B ADR-022) como INVARIANTE de query: método DIGITAL (lista
 * positiva NON_CASH_METHODS que sí usa el índice [method, status, capturedAt]; EXCLUYE CASH — el efectivo lo cobra
 * el conductor en mano, nunca entra al banco de VEO) + estado CAPTURED/PARTIALLY_REFUNDED. El service solo aporta el
 * instante `since` (ya calculado en TZ Lima) y COMPONE la definición de negocio (las restas del KPI) con los
 * componentes de suma que este repo devuelve — la FÓRMULA vive en el service, la QUERY vive acá.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, PaymentMethod, PaymentStatus, RefundStatus } from '../generated/prisma';
import { NON_CASH_METHODS } from '../payments/payment.policy';
import type { RevenueHourBucket, RevenueBucket } from './analytics.service';

/** Componentes del margen de la plataforma (cohorte digital capturado). Sumas ya defaulteadas a Int (jamás float). */
export interface MarginComponents {
  commissionCents: number;
  pspFeeCents: number;
  discountCents: number;
  creditCents: number;
}

/** Componentes del money-in del día (cohorte digital capturado). */
export interface MoneyInComponents {
  netSettledCents: number;
  refundedCents: number;
}

/** Totales del rango: money-in (netSettled) + comisión bruta (mismo cohorte). */
export interface RangeTotals {
  netSettledCents: number;
  commissionCents: number;
}

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Componentes del margen de la plataforma desde `since` (cohorte digital capturado HARDCODEADO). El service
   * compone `comisión − fee PSP − promo − crédito`. Réplica.
   */
  async sumMarginComponentsSince(since: Date): Promise<MarginComponents> {
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { commissionCents: true, pspFeeCents: true, discountCents: true, creditCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return {
      commissionCents: agg._sum.commissionCents ?? 0,
      pspFeeCents: agg._sum.pspFeeCents ?? 0,
      discountCents: agg._sum.discountCents ?? 0,
      creditCents: agg._sum.creditCents ?? 0,
    };
  }

  /**
   * Componentes del money-in desde `since` (mismo cohorte digital capturado). El service compone
   * `netSettled − refunded`. Réplica.
   */
  async sumMoneyInComponentsSince(since: Date): Promise<MoneyInComponents> {
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { netSettledCents: true, refundedCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return {
      netSettledCents: agg._sum.netSettledCents ?? 0,
      refundedCents: agg._sum.refundedCents ?? 0,
    };
  }

  /** Money-in + comisión bruta del rango desde `since` (mismo cohorte digital capturado). Réplica. */
  async sumRangeTotalsSince(since: Date): Promise<RangeTotals> {
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { netSettledCents: true, commissionCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return {
      netSettledCents: agg._sum.netSettledCents ?? 0,
      commissionCents: agg._sum.commissionCents ?? 0,
    };
  }

  /** Total reembolsado desde `since`: Σ `Refund.amountCents` de refunds COMPLETED (money-out confirmado). Réplica. */
  async sumCompletedRefundsSince(since: Date): Promise<number> {
    const agg = await this.prisma.read.refund.aggregate({
      _sum: { amountCents: true },
      where: { status: RefundStatus.COMPLETED, createdAt: { gte: since } },
    });
    return agg._sum.amountCents ?? 0;
  }

  /**
   * Serie de revenue por hora de las últimas 24h (bucket = date_trunc('hour', capturedAt) en UTC). Net-aware y
   * EXCLUYE CASH — misma definición que el money-in del día. Réplica.
   */
  async revenuePerHourBuckets(since: Date): Promise<RevenueHourBucket[]> {
    const rows = await this.prisma.read.$queryRaw<{ bucket: Date; revenue_cents: bigint }[]>(
      Prisma.sql`
        SELECT date_trunc('hour', "captured_at" AT TIME ZONE 'UTC')                    AS bucket,
               COALESCE(SUM("net_settled_cents" - COALESCE("refunded_cents", 0)), 0)::bigint AS revenue_cents
        FROM "payment"."payments"
        WHERE "status" IN (
                ${PaymentStatus.CAPTURED}::"payment"."PaymentStatus",
                ${PaymentStatus.PARTIALLY_REFUNDED}::"payment"."PaymentStatus"
              )
          AND "method" <> ${PaymentMethod.CASH}::"payment"."PaymentMethod"
          AND "captured_at" >= ${since}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    );
    return rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      revenueCents: Number(r.revenue_cents),
    }));
  }

  /**
   * Serie de money-in por bucket del rango: por HORA (`unit='hour'`, TODAY) o por DÍA (`unit='day'`, 7d/30d),
   * truncando en TZ America/Lima. Mismo cohorte digital → los buckets reconcilian con `sumRangeTotalsSince`. El
   * service decide la granularidad (dominio); el repo mapea a los literales SQL (granularity + formato). Réplica.
   */
  async revenueSeriesBuckets(since: Date, unit: 'hour' | 'day'): Promise<RevenueBucket[]> {
    // Literales entre comillas dobles ("T", ":00:00") → to_char no los interpreta como patrones; hora local de Lima.
    const format = unit === 'hour' ? 'YYYY-MM-DD"T"HH24":00:00"' : 'YYYY-MM-DD';
    const methodList = Prisma.join(
      NON_CASH_METHODS.map((m) => Prisma.sql`${m}::"payment"."PaymentMethod"`),
    );
    const rows = await this.prisma.read.$queryRaw<{ bucket: string; revenue_cents: bigint }[]>(
      Prisma.sql`
        SELECT to_char(
                 date_trunc(${unit}, "captured_at" AT TIME ZONE 'America/Lima'),
                 ${format}
               )                                                          AS bucket,
               COALESCE(SUM("net_settled_cents"), 0)::bigint              AS revenue_cents
        FROM "payment"."payments"
        WHERE "status" IN (
                ${PaymentStatus.CAPTURED}::"payment"."PaymentStatus",
                ${PaymentStatus.PARTIALLY_REFUNDED}::"payment"."PaymentStatus"
              )
          AND "method" IN (${methodList})
          AND "captured_at" >= ${since}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    );
    return rows.map((r) => ({ bucket: r.bucket, revenueCents: Number(r.revenue_cents) }));
  }
}
