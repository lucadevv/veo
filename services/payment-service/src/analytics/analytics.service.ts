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
import { Prisma, PaymentStatus } from '../generated/prisma';

/** Punto de la serie horaria de revenue. `bucket` = hora truncada en ISO UTC (toStartOfHour). */
export interface RevenueHourBucket {
  bucket: string;
  revenueCents: number;
}

export interface RevenueAnalytics {
  /** Suma en céntimos de la recaudación CAPTURADA hoy (desde medianoche America/Lima). */
  revenueTodayCents: number;
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
    const [revenueTodayCents, revenuePerHour] = await Promise.all([
      this.revenueToday(now),
      this.revenuePerHour(now),
    ]);
    return { revenueTodayCents, revenuePerHour };
  }

  /** Suma de amountCents de los cobros capturados desde la medianoche de Lima. Una sola query agregada. */
  private async revenueToday(now: Date): Promise<number> {
    const since = limaMidnightUtc(now);
    const agg = await this.prisma.read.payment.aggregate({
      _sum: { amountCents: true },
      where: {
        status: PaymentStatus.CAPTURED,
        capturedAt: { gte: since },
      },
    });
    return agg._sum.amountCents ?? 0;
  }

  /**
   * Revenue por hora de las últimas 24h. Bucket = date_trunc('hour', capturedAt) en UTC.
   * Agregación en una sola query (sin N+1 · sin sumar en loop). Sólo CAPTURED con capturedAt en ventana.
   */
  private async revenuePerHour(now: Date): Promise<RevenueHourBucket[]> {
    const since = new Date(now.getTime() - HOURS_24_MS);
    const rows = await this.prisma.read.$queryRaw<{ bucket: Date; revenue_cents: bigint }[]>(
      Prisma.sql`
        SELECT date_trunc('hour', "captured_at" AT TIME ZONE 'UTC') AS bucket,
               SUM("amount_cents")::bigint                          AS revenue_cents
        FROM "payment"."payments"
        WHERE "status" = ${PaymentStatus.CAPTURED}::"payment"."PaymentStatus"
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
