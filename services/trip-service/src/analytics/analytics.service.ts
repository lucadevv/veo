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

// Forma EXACTA que el endpoint devuelve: el contrato compartido TripStatsView (@veo/shared-types),
// MISMA forma que consume el admin-bff. Se re-exporta para los imports internos (controller).
export type { TripStatsView };

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(TRIP_STATS_REPO) private readonly repo: TripStatsRepository,
  ) {}

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
