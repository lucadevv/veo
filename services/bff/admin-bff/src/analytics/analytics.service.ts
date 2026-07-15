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
  /** Margen REAL de la plataforma hoy (payment-service ya lo computa; el bff lo reenvía → KPI "Margen hoy"). */
  platformMarginTodayCents: number;
  /** Viajes digitales de HOY (cobros FARE capturados) → KPI "Viajes hoy". */
  tripCountToday: number;
  /** Ticket promedio de HOY, DERIVADO por el bff = revenueTodayCents / tripCountToday (0 sin viajes). */
  avgTicketTodayCents: number;
  /** Tasa de cancelación de HOY, DERIVADA = cancelledToday / (completedToday + cancelledToday); null sin cierres. */
  cancellationRateToday: number | null;
  avgDurationSeconds: number | null;
  /** Viajes de HOY por MODO 3-way (FIXED | PUJA | CARPOOLING) — dato de payment-service (mismo bucketing que el
   *  revenue-por-modo). Alimenta el donut "Modos de servicio · viajes de hoy". [] si payment cae o no hay data. */
  byMode: { mode: string; trips: number }[];
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
export interface RevenueByMode {
  mode: string;
  revenueCents: number;
}

export interface RevenueByDistrict {
  district: string;
  revenueCents: number;
}

/** Variación % vs período previo (fracción: 0.18 = +18%); `null` si el previo no tiene base (0) — no se inventa. */
export interface RevenueDeltas {
  moneyInPct: number | null;
  tripCountPct: number | null;
  avgTicketPct: number | null;
}

export interface RevenueMetrics {
  range: RevenueRangeValue;
  moneyInCents: number;
  grossCommissionCents: number;
  refundedCents: number;
  platformMarginCents: number;
  /** Viajes digitales del rango (kind=FARE) — dato de payment-service. */
  tripCount: number;
  /** Ticket promedio DERIVADO por el bff = moneyInCents / tripCount (0 sin viajes). */
  avgTicketCents: number;
  /** Revenue por modo 3-way (FIXED | PUJA | CARPOOLING) — dato de payment-service (denormaliza el dispatchMode). */
  byMode: RevenueByMode[];
  /** Revenue por DISTRITO de origen (zonificado en payment), ordenado desc. Alimenta "Top distritos por ingreso". */
  topDistricts: RevenueByDistrict[];
  /** Deltas % vs período previo, DERIVADOS por el bff. */
  deltas: RevenueDeltas;
  series: RevenueSeriesPoint[];
}

/** Shape crudo servido por payment-service (GET /internal/analytics/revenue-metrics) — sin margen ni deltas derivados. */
interface RevenueRangeStats {
  moneyInCents: number;
  grossCommissionCents: number;
  refundedCents: number;
  tripCount: number;
  byMode: RevenueByMode[];
  topDistricts: RevenueByDistrict[];
  previous: { moneyInCents: number; tripCount: number };
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
  platformMarginTodayCents: number;
  tripCountToday: number;
  byMode: { mode: string; trips: number }[];
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

    const completedToday = trip?.completedToday ?? 0;
    const cancelledToday = trip?.cancelledToday ?? 0;
    const revenueTodayCents = payment?.revenueTodayCents ?? 0;
    const tripCountToday = payment?.tripCountToday ?? 0;
    const closedToday = completedToday + cancelledToday;
    return {
      activeTrips: trip?.activeTrips ?? 0,
      onlineDrivers: dispatch?.onlineDrivers ?? 0,
      openPanics: panic?.openPanics ?? 0,
      completedToday,
      cancelledToday,
      revenueTodayCents,
      // Margen que payment YA computa (antes se dropeaba) + derivados del bff (ticket promedio, tasa cancelación).
      platformMarginTodayCents: payment?.platformMarginTodayCents ?? 0,
      tripCountToday,
      avgTicketTodayCents: tripCountToday > 0 ? Math.round(revenueTodayCents / tripCountToday) : 0,
      cancellationRateToday: closedToday > 0 ? cancelledToday / closedToday : null,
      avgDurationSeconds: trip?.avgDurationSeconds ?? null,
      // Viajes de hoy por modo (donut). Degradación honesta: payment caído → [] (no dato inventado).
      byMode: payment?.byMode ?? [],
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
    const tripCount = stats?.tripCount ?? 0;
    const byMode = stats?.byMode ?? [];
    const topDistricts = stats?.topDistricts ?? [];
    const series = stats?.series ?? [];
    // Derivados (una sola responsabilidad del bff, como el margen): ticket promedio + deltas % vs período previo.
    const avgTicketCents = tripCount > 0 ? Math.round(moneyInCents / tripCount) : 0;
    const prevMoneyIn = stats?.previous.moneyInCents ?? 0;
    const prevTripCount = stats?.previous.tripCount ?? 0;
    const prevAvg = prevTripCount > 0 ? prevMoneyIn / prevTripCount : 0;
    // %Δ = (actual − previo) / previo; null si el previo es 0 (sin base) → la UI muestra el KPI sin delta, no un % falso.
    const pct = (cur: number, prev: number): number | null => (prev > 0 ? (cur - prev) / prev : null);
    const deltas: RevenueDeltas = {
      moneyInPct: pct(moneyInCents, prevMoneyIn),
      tripCountPct: pct(tripCount, prevTripCount),
      avgTicketPct: prevAvg > 0 ? (avgTicketCents - prevAvg) / prevAvg : null,
    };
    this.logger.info(
      {
        range,
        moneyInCents,
        grossCommissionCents,
        refundedCents,
        platformMarginCents,
        tripCount,
        avgTicketCents,
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
      tripCount,
      avgTicketCents,
      byMode,
      topDistricts,
      deltas,
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
