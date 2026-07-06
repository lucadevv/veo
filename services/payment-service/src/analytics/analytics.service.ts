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
import { Prisma, PaymentMethod, PaymentStatus } from '../generated/prisma';

/**
 * Métodos DIGITALES = todos MENOS CASH (el efectivo lo cobra el conductor en mano, nunca llega al banco de VEO).
 * Lista POSITIVA a propósito: `method IN (…)` puede hacer seek en el índice `[method, status, capturedAt]`; la
 * negación `method != CASH` NO (la anula → full-scan). Si se agrega un método digital al enum, sumarlo acá.
 */
const NON_CASH_METHODS = [
  PaymentMethod.YAPE,
  PaymentMethod.PLIN,
  PaymentMethod.CARD,
  PaymentMethod.PAGOEFECTIVO,
] as const;

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

/** America/Lima = UTC-5 fijo (Perú no aplica horario de verano). */
const LIMA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;

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
}
