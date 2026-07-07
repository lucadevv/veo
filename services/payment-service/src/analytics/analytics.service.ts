/**
 * AnalyticsService — KPIs internos de recaudación para el dashboard admin.
 *
 * Sólo lee datos PROPIOS de payment-service (sin joins cross-servicio · CLAUDE §2). Todo el dinero
 * en céntimos enteros (CLAUDE §3) — NUNCA float.
 *
 * Campo de monto usado para "recaudación": `amountCents` = total efectivamente cobrado al pasajero
 * (grossCents − discountCents − creditCents + tipCents). Es la PLATA que entró por los rieles a VEO
 * en el cobro, que es lo que el KPI "recaudación hoy" del dashboard reconoce. `netCents` no existe
 * como columna; el "neto" del conductor (gross − comisión + propina) es otra magnitud (lo que VEO
 * PAGA, no lo que RECAUDA) → no aplica acá.
 *
 * Estado: sólo cobros CAPTURADOS (status=CAPTURED, vía el enum tipado PaymentStatus — sin string
 * mágico) y con `capturedAt != null` (efectivamente capturados).
 *
 * Zona horaria de negocio: America/Lima (UTC-5, sin DST). "Hoy" = desde la medianoche de Lima.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, PaymentMethod, PaymentStatus, RefundStatus } from '../generated/prisma';
// Fuente ÚNICA de "métodos digitales" (lista positiva que sí usa el índice) — compartida con collectEarnings.
import { NON_CASH_METHODS } from '../payments/payment.policy';

/** Punto de la serie horaria de revenue. `bucket` = hora truncada en ISO UTC (toStartOfHour). */
export interface RevenueHourBucket {
  bucket: string;
  revenueCents: number;
}

export interface RevenueAnalytics {
  /** P-B · "Money-in REAL" hoy: Σ `netSettledCents` (neto del fee PSP), NO el bruto (desde medianoche Lima). */
  revenueTodayCents: number;
  /** P-B · Margen REAL de la plataforma hoy = Σ comisión − Σ fee PSP (lo que retiene neto del costo del PSP). */
  platformMarginTodayCents: number;
  /** Revenue por hora de las últimas 24h, bucket por hora UTC, orden ascendente. */
  revenuePerHour: RevenueHourBucket[];
}

/**
 * Rango temporal de las métricas de revenue del dashboard admin. Union TIPADA (const-object · cero strings
 * mágicos): comparar contra un literal fuera del set es error de compilación. `today` = desde la medianoche de
 * Lima; `7d`/`30d` = últimos 7/30 días NATURALES en TZ Lima (N buckets diarios contando hoy hacia atrás).
 */
export const RevenueRange = {
  TODAY: 'today',
  SEVEN_DAYS: '7d',
  THIRTY_DAYS: '30d',
} as const;
export type RevenueRange = (typeof RevenueRange)[keyof typeof RevenueRange];

/** Narrowing tipado: valida un string desconocido contra el union `RevenueRange` (sin comparar literales sueltos). */
export function isRevenueRange(value: unknown): value is RevenueRange {
  return (
    value === RevenueRange.TODAY ||
    value === RevenueRange.SEVEN_DAYS ||
    value === RevenueRange.THIRTY_DAYS
  );
}

/** Un punto de la serie de revenue del rango. `bucket` = hora (today) o día (7d/30d) en hora local de Lima. */
export interface RevenueBucket {
  bucket: string;
  revenueCents: number;
}

/**
 * Métricas de revenue de un RANGO para el dashboard admin (interno · lo consume el admin-bff). Devuelve los
 * HECHOS crudos de dinero (todos en céntimos Int); el `platformMarginCents` (= grossCommission − refunded) lo
 * DERIVA el bff (este interno no lo compone, mantiene una sola responsabilidad: agregar el dato PROPIO).
 */
export interface RevenueRangeMetrics {
  /** "Money-in REAL" del rango: Σ `netSettledCents` (neto del fee PSP) de cobros DIGITALES capturados en el rango. */
  moneyInCents: number;
  /** Comisión BRUTA de la plataforma sobre los cobros del rango: Σ `commissionCents` (mismo cohorte que money-in). */
  grossCommissionCents: number;
  /** Total REEMBOLSADO en el rango: Σ `Refund.amountCents` de refunds COMPLETED (parciales + totales), por `createdAt`. */
  refundedCents: number;
  /** Serie de money-in por bucket (hora si `today`, día si `7d`/`30d`) — MISMA definición que `moneyInCents`. */
  series: RevenueBucket[];
}

/** America/Lima = UTC-5 fijo (Perú no aplica horario de verano). */
const LIMA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cantidad de días NATURALES que abarca cada rango (contando hoy) → N buckets diarios en 7d/30d. */
const RANGE_DAYS: Readonly<Record<RevenueRange, number>> = {
  [RevenueRange.TODAY]: 1,
  [RevenueRange.SEVEN_DAYS]: 7,
  [RevenueRange.THIRTY_DAYS]: 30,
};

/** Medianoche de Lima del día que contiene `now`, como instante UTC. */
export function limaMidnightUtc(now: Date): Date {
  // Llevamos `now` a hora local de Lima, truncamos al inicio del día, y volvemos a UTC.
  const limaNow = new Date(now.getTime() - LIMA_UTC_OFFSET_MS);
  const limaMidnight = Date.UTC(
    limaNow.getUTCFullYear(),
    limaNow.getUTCMonth(),
    limaNow.getUTCDate(),
  );
  return new Date(limaMidnight + LIMA_UTC_OFFSET_MS);
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(now: Date = new Date()): Promise<RevenueAnalytics> {
    const [revenueTodayCents, platformMarginTodayCents, revenuePerHour] = await Promise.all([
      this.revenueToday(now),
      this.platformMarginToday(now),
      this.revenuePerHour(now),
    ]);
    return { revenueTodayCents, platformMarginTodayCents, revenuePerHour };
  }

  /**
   * P-B (ADR-022) · Margen REAL de la plataforma hoy realizado en el BANCO = Σ comisión − Σ fee PSP − Σ descuento
   * − Σ crédito. La comisión es el corte de la plataforma; el fee PSP es el costo del proveedor; promo (`discountCents`)
   * y crédito de referido (`creditCents`) los ABSORBE la plataforma (salen de su comisión). EXCLUYE CASH: la comisión
   * cash el conductor la debe (DriverDebt) y se recauda vía netting, no llega al banco hoy. Legacy (pspFee NULL) → 0.
   */
  private async platformMarginToday(now: Date): Promise<number> {
    const since = limaMidnightUtc(now);
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { commissionCents: true, pspFeeCents: true, discountCents: true, creditCents: true },
      where: {
        // Misma reformulación positiva que revenueToday: `in [digitales]` usa el índice; `!= CASH` lo anula.
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return (
      (agg._sum.commissionCents ?? 0) -
      (agg._sum.pspFeeCents ?? 0) -
      (agg._sum.discountCents ?? 0) -
      (agg._sum.creditCents ?? 0)
    );
  }

  /**
   * P-B (ADR-022) · "Money-in REAL" del día = la plata NETA que llega al BANCO de la plataforma. DOS ajustes clave
   * (gate): (1) EXCLUYE CASH — el efectivo lo cobra el conductor EN MANO, nunca llega al banco de VEO (la comisión
   * cash se recauda aparte vía DriverDebt+netting). (2) usa `netSettledCents` (= bruto − fee PSP), no el bruto. Suma
   * también los PARTIALLY_REFUNDED (su neto SÍ llegó) y RESTA lo reembolsado (money-out). Legacy (netSettled NULL) →
   * SUM lo ignora (undercount transitorio). Es lo que de verdad entró al banco, no lo cobrado.
   */
  private async revenueToday(now: Date): Promise<number> {
    const since = limaMidnightUtc(now);
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { netSettledCents: true, refundedCents: true },
      where: {
        // Lista POSITIVA de métodos digitales (no `method != CASH`): la NEGACIÓN no puede seek en el índice
        // [method, status, capturedAt] → lo anulaba (full-scan). Un `in` sí lo usa (seek por método + rango).
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return (agg._sum.netSettledCents ?? 0) - (agg._sum.refundedCents ?? 0);
  }

  /**
   * Revenue por hora de las últimas 24h. Bucket = date_trunc('hour', capturedAt) en UTC.
   * Agregación en una sola query (sin N+1 · sin sumar en loop). CAPTURED + PARTIALLY_REFUNDED, neto de refunds,
   * EXCLUYE CASH — misma definición que revenueToday (la serie 24h reconcilia con el total del día).
   */
  private async revenuePerHour(now: Date): Promise<RevenueHourBucket[]> {
    const since = new Date(now.getTime() - HOURS_24_MS);
    const rows = await this.prisma.read.$queryRaw<{ bucket: Date; revenue_cents: bigint }[]>(
      // P-B · net-aware + EXCLUYE CASH, coherente EXACTA con revenueToday (misma definición de "money-in" en el
      // MISMO dashboard, para que la suma de los buckets cuadre con el total del día): incluye PARTIALLY_REFUNDED
      // y RESTA refunded_cents (antes filtraba solo CAPTURED y NO restaba → la serie 24h no reconciliaba con
      // revenueToday). Suma el NETO al banco (net_settled_cents − refunded_cents) de los cobros DIGITALES por
      // hora, atribuyendo el reembolso a la hora de la captura original. Legacy (net_settled NULL) → SUM lo ignora.
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
   * Pantalla "Métricas" del admin (F · revenue por rango). Agrega los HECHOS de dinero del rango elegido — todo
   * PROPIO de payment-service (sin joins cross-servicio · CLAUDE §2), todo en céntimos Int (§3). Tres agregados en
   * PARALELO (money-in + comisión desde `payments`, refunds desde `refunds`) + la serie por bucket. El
   * `platformMarginCents` NO se compone acá (lo deriva el bff): este interno devuelve solo el dato crudo.
   *
   * Definición de "money-in" (idéntica al KPI de overview): Σ `netSettledCents` (neto del fee PSP = plata REAL que
   * llegó al banco) de cobros DIGITALES (excluye CASH: el efectivo lo cobra el conductor en mano, nunca entra al
   * banco de VEO) en estado CAPTURED/PARTIALLY_REFUNDED con `capturedAt` en el rango. Legacy (netSettled NULL) → el
   * SUM lo ignora (undercount honesto). La serie usa EXACTAMENTE este cohorte → sus buckets reconcilian con el total.
   */
  async revenueMetrics(range: RevenueRange, now: Date = new Date()): Promise<RevenueRangeMetrics> {
    const [totals, refundedCents, series] = await Promise.all([
      this.rangeTotals(range, now),
      this.refundedInRange(range, now),
      this.revenueSeries(range, now),
    ]);
    return {
      moneyInCents: totals.moneyInCents,
      grossCommissionCents: totals.grossCommissionCents,
      refundedCents,
      series,
    };
  }

  /** Instante UTC del inicio del rango: medianoche de Lima de hoy menos (N−1) días naturales (N buckets diarios). */
  private rangeStartUtc(range: RevenueRange, now: Date): Date {
    const todayMidnight = limaMidnightUtc(now);
    return new Date(todayMidnight.getTime() - (RANGE_DAYS[range] - 1) * DAY_MS);
  }

  /**
   * Money-in + comisión BRUTA del rango en UNA sola query agregada (sin N+1). Cohorte: cobros DIGITALES
   * (lista positiva NON_CASH_METHODS → usa el índice [method, status, capturedAt]) CAPTURED/PARTIALLY_REFUNDED con
   * `capturedAt` en el rango. Los REFUNDED totales quedan FUERA del cohorte (su comisión se revirtió con el viaje).
   */
  private async rangeTotals(
    range: RevenueRange,
    now: Date,
  ): Promise<{ moneyInCents: number; grossCommissionCents: number }> {
    const since = this.rangeStartUtc(range, now);
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { netSettledCents: true, commissionCents: true },
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        capturedAt: { gte: since },
      },
    });
    return {
      moneyInCents: agg._sum.netSettledCents ?? 0,
      grossCommissionCents: agg._sum.commissionCents ?? 0,
    };
  }

  /**
   * Total reembolsado en el rango = Σ `Refund.amountCents` de refunds COMPLETED (money-out REAL confirmado por el
   * proveedor; PENDING/APPROVED/REJECTED NO cuentan). Incluye parciales y totales. Atribución por `createdAt` (cuándo
   * se inició el reembolso): es INMUTABLE y testeable (a diferencia de `updatedAt`, que Prisma auto-bumpea); el
   * reembolso se completa poco después de crearse → aproximación fiel para el KPI. Fuente separada de `payments`
   * (el money-out no se descuenta del money-in acá — el bff arma el margen = comisión − reembolsos).
   */
  private async refundedInRange(range: RevenueRange, now: Date): Promise<number> {
    const since = this.rangeStartUtc(range, now);
    const agg = await this.prisma.read.refund.aggregate({
      _sum: { amountCents: true },
      where: {
        status: RefundStatus.COMPLETED,
        createdAt: { gte: since },
      },
    });
    return agg._sum.amountCents ?? 0;
  }

  /**
   * Serie de money-in por bucket: por HORA si `today` (buckets de hora local de Lima), por DÍA si `7d`/`30d`.
   * Una sola query con `date_trunc` en TZ America/Lima (los bordes de día de Lima caen a las 05:00 UTC — truncar en
   * UTC daría días corridos). El label sale por `to_char` como string ISO-naïve de hora LOCAL de Lima (zero-padded →
   * el orden lexical == cronológico). MISMO cohorte/definición que `rangeTotals` (Σ netSettled digital) → la suma de
   * los buckets reconcilia EXACTA con `moneyInCents`.
   */
  private async revenueSeries(range: RevenueRange, now: Date): Promise<RevenueBucket[]> {
    const since = this.rangeStartUtc(range, now);
    const isToday = range === RevenueRange.TODAY;
    // `date_trunc(unit, ...)` y `to_char(..., fmt)` toman el granularidad/formato como parámetros TEXT (bind-safe).
    const granularity = isToday ? 'hour' : 'day';
    // Literales entre comillas dobles ("T", ":00:00") → to_char no los interpreta como patrones; hora local de Lima.
    const format = isToday ? 'YYYY-MM-DD"T"HH24":00:00"' : 'YYYY-MM-DD';
    const methodList = Prisma.join(
      NON_CASH_METHODS.map((m) => Prisma.sql`${m}::"payment"."PaymentMethod"`),
    );
    const rows = await this.prisma.read.$queryRaw<{ bucket: string; revenue_cents: bigint }[]>(
      Prisma.sql`
        SELECT to_char(
                 date_trunc(${granularity}, "captured_at" AT TIME ZONE 'America/Lima'),
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
