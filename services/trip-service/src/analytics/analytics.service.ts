/**
 * AnalyticsService — KPIs reales del dashboard admin, SOLO con datos de trip-service (sin cross-service).
 * Orquesta IO: cada métrica es una agregación del repo (count / aggregate / groupBy por hora); el día
 * "hoy" se ancla a medianoche America/Lima (UTC-5 fijo, Perú NO tiene DST). Clean arch: depende del
 * puerto TRIP_STATS_REPO, no de Prisma.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type TripStatsView } from '@veo/shared-types';
import { TRIP_STATS_REPO, type TripStatsRepository } from './analytics.repository';

/** Offset fijo de America/Lima respecto a UTC (UTC-5, sin horario de verano). */
const LIMA_UTC_OFFSET_HOURS = 5;
const HOUR_MS = 60 * 60 * 1000;
const TRIPS_PER_HOUR_WINDOW_HOURS = 24;

/** Ventana FIJA de las métricas por-servicio del detalle de catálogo: 30 días naturales hacia atrás. */
export const OFFERING_METRICS_WINDOW_DAYS = 30;
const DAY_MS = 24 * HOUR_MS;

// Forma EXACTA que el endpoint devuelve: el contrato compartido TripStatsView (@veo/shared-types),
// MISMA forma que consume el admin-bff. Se re-exporta para los imports internos (controller).
export type { TripStatsView };

/**
 * Métricas 30d de UNA oferta para la página-detalle del catálogo admin (board HjDvx · "Ofertas · Detalle").
 * Datos PROPIOS de trip-service (Trip.category = offering id, sin cross-service): nº de viajes COMPLETADOS y
 * la facturación BRUTA (Σ fareCents) del MISMO cohorte. HONESTIDAD DE DATOS: el revenue NETO (net-settled) por
 * oferta NO existe (payment-service no denormaliza el offering) y el rating por oferta no tiene fuente → NO se
 * exponen acá (se omiten en la UI). `grossFareCents` es facturación bruta, no el margen de la plataforma.
 */
export interface OfferingMetrics {
  offeringId: string;
  windowDays: number;
  /** Viajes COMPLETADOS de la oferta en la ventana (Trip.category = offeringId). */
  tripCount: number;
  /** Facturación BRUTA de esos viajes: Σ Trip.fareCents (céntimos PEN Int). NO es el neto de la plataforma. */
  grossFareCents: number;
}

@Injectable()
export class AnalyticsService {
  constructor(@Inject(TRIP_STATS_REPO) private readonly repo: TripStatsRepository) {}

  async getTripStats(now: Date = new Date()): Promise<TripStatsView> {
    const limaMidnight = startOfLimaDay(now);
    const windowStart = new Date(now.getTime() - TRIPS_PER_HOUR_WINDOW_HOURS * HOUR_MS);

    // Todas las agregaciones en paralelo: queries independientes del motor, sin N+1.
    const [activeTrips, completedToday, cancelledToday, avgDurationSeconds, tripsPerHour] =
      await Promise.all([
        this.repo.countActive(),
        this.repo.countCompletedSince(limaMidnight),
        this.repo.countCancelledSince(limaMidnight),
        this.repo.avgActiveDurationSeconds(),
        this.repo.tripsPerHourSince(windowStart),
      ]);

    return {
      activeTrips,
      completedToday,
      cancelledToday,
      avgDurationSeconds: avgDurationSeconds === null ? null : Math.round(avgDurationSeconds),
      tripsPerHour,
    };
  }

  /**
   * Métricas 30d de UNA oferta (página-detalle del catálogo). Ventana FIJA de 30 días naturales hacia atrás
   * desde `now` (ancla horaria irrelevante para 30d; se toma `now − 30d` directo). Delega la agregación al repo
   * (count + Σ fareCents del cohorte COMPLETED · category). El `offeringId` ya viene validado por el DTO.
   */
  async getOfferingMetrics(offeringId: string, now: Date = new Date()): Promise<OfferingMetrics> {
    const since = new Date(now.getTime() - OFFERING_METRICS_WINDOW_DAYS * DAY_MS);
    const { tripCount, grossFareCents } = await this.repo.offeringMetricsSince(offeringId, since);
    return { offeringId, windowDays: OFFERING_METRICS_WINDOW_DAYS, tripCount, grossFareCents };
  }
}

/**
 * Instante UTC de la medianoche de HOY en America/Lima (UTC-5 fijo). Tomamos la pared-de-reloj Lima de
 * `now` (now - 5h), la truncamos al día, y la devolvemos a UTC sumando las 5h. Sin libs de TZ ni DST
 * (Perú no observa horario de verano).
 */
function startOfLimaDay(now: Date): Date {
  const limaWallClock = new Date(now.getTime() - LIMA_UTC_OFFSET_HOURS * HOUR_MS);
  const limaMidnightWallClock = Date.UTC(
    limaWallClock.getUTCFullYear(),
    limaWallClock.getUTCMonth(),
    limaWallClock.getUTCDate(),
  );
  return new Date(limaMidnightWallClock + LIMA_UTC_OFFSET_HOURS * HOUR_MS);
}
