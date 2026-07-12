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
import {
  Prisma,
  PaymentMethod,
  PaymentMode,
  PaymentKind,
  PaymentStatus,
  RefundStatus,
} from '../generated/prisma';
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

  /**
   * Money-in + comisión bruta de una VENTANA `[since, until)` (mismo cohorte digital capturado). `until` opcional:
   * sin él la ventana es abierta (`>= since`, el rango actual); con él es acotada (para el período PREVIO del delta).
   * Réplica.
   */
  async sumRangeTotalsSince(since: Date, until?: Date): Promise<RangeTotals> {
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { netSettledCents: true, commissionCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since, ...(until ? { lt: until } : {}) },
      },
    });
    return {
      netSettledCents: agg._sum.netSettledCents ?? 0,
      commissionCents: agg._sum.commissionCents ?? 0,
    };
  }

  /**
   * Conteo de VIAJES digitales de la ventana `[since, until)`: cobros `kind=FARE` capturados (uno por viaje — el
   * `TIP` es un cobro digital aparte que NO cuenta como viaje). Mismo cohorte digital. Habilita "Viajes" y
   * "Ticket promedio" (= moneyIn / count). Réplica.
   */
  async countFareTripsSince(since: Date, until?: Date): Promise<number> {
    return this.prisma.read.payment.count({
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        kind: PaymentKind.FARE,
        capturedAt: { gte: since, ...(until ? { lt: until } : {}) },
      },
    });
  }

  /**
   * Revenue (Σ netSettled) por MODO de la ventana `[since, until)`, en 3 VÍAS para el desglose del panel
   * (Fijo/Puja/Carpooling): el `Payment.mode` da CARPOOLING vs ON_DEMAND, y el ON_DEMAND se DIVIDE por el
   * `dispatchMode` (FIXED/PUJA) que payment DENORMALIZA del `trip.completed` (sin join cross-servicio · CLAUDE §2).
   * `mode` null (legacy) → ON_DEMAND; `dispatchMode` null (evento viejo) → FIXED (el default del despacho). Mismo
   * cohorte digital. Réplica. Devuelve buckets 'FIXED' | 'PUJA' | 'CARPOOLING'.
   */
  async sumRevenueByModeSince(
    since: Date,
    until?: Date,
  ): Promise<{ mode: string; revenueCents: number }[]> {
    const rows = await this.prisma.read.payment.groupBy({
      by: ['mode', 'dispatchMode'],
      _sum: { netSettledCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since, ...(until ? { lt: until } : {}) },
      },
    });
    const byMode = new Map<string, number>();
    for (const r of rows) {
      const mode = r.mode ?? PaymentMode.ON_DEMAND;
      // Carpooling es su propio bucket; el on-demand se parte en Fijo/Puja según el modo de despacho denormalizado.
      const bucket = mode === PaymentMode.CARPOOLING ? 'CARPOOLING' : (r.dispatchMode ?? 'FIXED');
      byMode.set(bucket, (byMode.get(bucket) ?? 0) + (r._sum.netSettledCents ?? 0));
    }
    return [...byMode.entries()].map(([mode, revenueCents]) => ({ mode, revenueCents }));
  }

  /**
   * Revenue (Σ netSettled) por DISTRITO de origen de la ventana `[since, until)`, para el corte "Ingresos por
   * distrito" del panel. El `Payment.district` lo ZONIFICÓ payment en la captura (lat/lng del `trip.completed` →
   * distrito de Lima) y quedó denormalizado — no se re-zonifica ni joinea. `district` null (cobro sin geo / fuera
   * de cobertura) se EXCLUYE (degradación honesta, no un bucket "desconocido"). Mismo cohorte digital. Ordenado
   * desc por revenue. Réplica.
   */
  async sumRevenueByDistrictSince(
    since: Date,
    until?: Date,
  ): Promise<{ district: string; revenueCents: number }[]> {
    const rows = await this.prisma.read.payment.groupBy({
      by: ['district'],
      _sum: { netSettledCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since, ...(until ? { lt: until } : {}) },
        district: { not: null },
      },
    });
    return rows
      .filter((r): r is typeof r & { district: string } => r.district != null)
      .map((r) => ({ district: r.district, revenueCents: r._sum.netSettledCents ?? 0 }))
      .sort((a, b) => b.revenueCents - a.revenueCents);
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
