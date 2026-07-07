/**
 * AnalyticsService — KPIs del dashboard agregados desde los servicios OLTP (cada uno dueño de SU dato,
 * sin joins cross-servicio). El admin-bff es el agregador (BFF): llama en PARALELO los endpoints internos
 * de stats (trip/dispatch/panic/payment), firmados HMAC, y arma el contrato `OverviewMetrics`.
 *
 * Degradación HONESTA: si un servicio no responde, su KPI cae a 0 / [] / null (jamás dato inventado) —
 * el dashboard sigue mostrando el resto. La serie horaria mergea trips (trip-service) + revenue
 * (payment-service) por bucket.
 *
 * GPS/OLAP (activeDrivers/pings por hora desde ClickHouse) NO entra en este contrato — es otra capacidad
 * (ver clickhouse.service.ts, marcado DEUDA hasta que tracking-service + ClickHouse estén arriba).
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { type TripStatsView } from '@veo/shared-types';
import type { RevenueRangeValue } from '@veo/api-client';
import { LOGGER, type Logger } from '@veo/observability';
import { REST_TRIP, REST_DISPATCH, REST_PANIC, REST_PAYMENT } from '../infra/tokens';

export interface OverviewSeriesPoint {
  bucket: string;
  trips: number;
  revenueCents: number;
}

export interface OverviewMetrics {
  activeTrips: number;
  onlineDrivers: number;
  openPanics: number;
  completedToday: number;
  cancelledToday: number;
  revenueTodayCents: number;
  avgDurationSeconds: number | null;
  series: OverviewSeriesPoint[];
}

/** Un punto de la serie de revenue por rango (bucket local Lima → money-in neto del bucket). */
export interface RevenueSeriesPoint {
  bucket: string;
  revenueCents: number;
}

/**
 * Contrato que la pantalla "Métricas" consume (GET /analytics/revenue?range). Espeja `revenueMetricsView`
 * (@veo/api-client). Todo en céntimos Int. `platformMarginCents` lo DERIVA este bff (= grossCommission − refunded).
 */
export interface RevenueMetrics {
  range: RevenueRangeValue;
  moneyInCents: number;
  grossCommissionCents: number;
  refundedCents: number;
  platformMarginCents: number;
  series: RevenueSeriesPoint[];
}

/** Shape crudo servido por payment-service (GET /internal/analytics/revenue-metrics) — sin el margen derivado. */
interface RevenueRangeStats {
  moneyInCents: number;
  grossCommissionCents: number;
  refundedCents: number;
  series: RevenueSeriesPoint[];
}

/**
 * Shapes internos servidos por cada microservicio (GET /internal/analytics/*).
 * El de trip-stats es el contrato compartido TripStatsView (@veo/shared-types) — MISMA forma que
 * produce trip-service, así el contrato no diverge (productor↔consumidor).
 */
interface OnlineDriversStat {
  onlineDrivers: number;
}
interface OpenPanicsStat {
  openPanics: number;
}
interface RevenueStats {
  revenueTodayCents: number;
  revenuePerHour: { bucket: string; revenueCents: number }[];
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(REST_TRIP) private readonly tripRest: InternalRestClient,
    @Inject(REST_DISPATCH) private readonly dispatchRest: InternalRestClient,
    @Inject(REST_PANIC) private readonly panicRest: InternalRestClient,
    @Inject(REST_PAYMENT) private readonly paymentRest: InternalRestClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async overview(identity: AuthenticatedUser): Promise<OverviewMetrics> {
    const [trip, dispatch, panic, payment] = await Promise.all([
      this.safe<TripStatsView>(
        () => this.tripRest.get('/internal/analytics/trip-stats', { identity }),
        'trip-stats',
      ),
      this.safe<OnlineDriversStat>(
        () => this.dispatchRest.get('/internal/analytics/online-drivers', { identity }),
        'online-drivers',
      ),
      this.safe<OpenPanicsStat>(
        () => this.panicRest.get('/internal/analytics/open-count', { identity }),
        'open-count',
      ),
      this.safe<RevenueStats>(
        () => this.paymentRest.get('/internal/analytics/revenue', { identity }),
        'revenue',
      ),
    ]);

    return {
      activeTrips: trip?.activeTrips ?? 0,
      onlineDrivers: dispatch?.onlineDrivers ?? 0,
      openPanics: panic?.openPanics ?? 0,
      completedToday: trip?.completedToday ?? 0,
      cancelledToday: trip?.cancelledToday ?? 0,
      revenueTodayCents: payment?.revenueTodayCents ?? 0,
      avgDurationSeconds: trip?.avgDurationSeconds ?? null,
      series: this.mergeSeries(trip?.tripsPerHour ?? [], payment?.revenuePerHour ?? []),
    };
  }

  /**
   * Pantalla "Métricas" (revenue por rango). Llama el interno HMAC de payment-service (money-in + comisión bruta +
   * reembolsos + serie) y DERIVA el `platformMarginCents = grossCommissionCents − refundedCents`. Degradación
   * HONESTA: si payment-service no responde, todo cae a 0 / [] (jamás dato inventado) y el margen a 0. Observabilidad
   * (regla del repo): log estructurado con el rango + el resumen; la métrica HTTP la emite el interceptor global.
   */
  async revenue(identity: AuthenticatedUser, range: RevenueRangeValue): Promise<RevenueMetrics> {
    const stats = await this.safe<RevenueRangeStats>(
      () =>
        this.paymentRest.get('/internal/analytics/revenue-metrics', {
          identity,
          query: { range },
        }),
      'revenue-metrics',
    );
    const moneyInCents = stats?.moneyInCents ?? 0;
    const grossCommissionCents = stats?.grossCommissionCents ?? 0;
    const refundedCents = stats?.refundedCents ?? 0;
    const platformMarginCents = grossCommissionCents - refundedCents;
    const series = stats?.series ?? [];
    this.logger.info(
      {
        range,
        moneyInCents,
        grossCommissionCents,
        refundedCents,
        platformMarginCents,
        buckets: series.length,
        degraded: stats === null,
      },
      'analytics revenue por rango agregada',
    );
    return {
      range,
      moneyInCents,
      grossCommissionCents,
      refundedCents,
      platformMarginCents,
      series,
    };
  }

  /** Une trips/hora (trip-service) y revenue/hora (payment-service) por bucket horario → serie del chart. */
  private mergeSeries(
    trips: { bucket: string; trips: number }[],
    revenue: { bucket: string; revenueCents: number }[],
  ): OverviewSeriesPoint[] {
    const byBucket = new Map<string, OverviewSeriesPoint>();
    for (const t of trips) {
      byBucket.set(t.bucket, { bucket: t.bucket, trips: t.trips, revenueCents: 0 });
    }
    for (const r of revenue) {
      const existing = byBucket.get(r.bucket);
      if (existing) existing.revenueCents = r.revenueCents;
      else byBucket.set(r.bucket, { bucket: r.bucket, trips: 0, revenueCents: r.revenueCents });
    }
    return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  /** Ejecuta una llamada interna y, si falla (servicio caído), degrada a null + nota en el log. */
  private async safe<T>(fn: () => Promise<T>, source: string): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn({ err, source }, 'fuente de métrica del dashboard no disponible');
      return null;
    }
  }
}
