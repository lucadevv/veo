/**
 * AnalyticsService — métricas reales del dashboard agregadas desde ClickHouse (histórico GPS de
 * tracking-service). Si una fuente/tabla no existe aún, la métrica se devuelve en 0/empty con un flag
 * `available:false` (jamás datos inventados).
 */
import { Injectable, Inject } from '@nestjs/common';
import { LOGGER, type Logger } from '@veo/observability';
import { ClickHouseService } from './clickhouse.service';

export interface OverviewMetrics {
  generatedAt: string;
  windowHours: number;
  gps: {
    available: boolean;
    activeDrivers: number;
    pings: number;
    tripsWithActivity: number;
  };
  tripsPerHour: {
    available: boolean;
    points: { hour: string; trips: number }[];
  };
  notes: string[];
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async overview(windowHours = 1): Promise<OverviewMetrics> {
    const notes: string[] = [];

    const gps = await this.safe(
      () =>
        this.clickhouse.query<{ active_drivers: string; pings: string; trips: string }>(
          `SELECT uniqExact(driver_id) AS active_drivers, count() AS pings, uniqExactIf(trip_id, trip_id != '') AS trips
           FROM gps_pings WHERE recorded_at >= now() - INTERVAL ${windowHours} HOUR`,
        ),
      'gps_pings',
      notes,
    );

    const series = await this.safe(
      () =>
        this.clickhouse.query<{ hour: string; trips: string }>(
          `SELECT toString(toStartOfHour(recorded_at)) AS hour, uniqExactIf(trip_id, trip_id != '') AS trips
           FROM gps_pings WHERE recorded_at >= now() - INTERVAL 24 HOUR
           GROUP BY hour ORDER BY hour`,
        ),
      'gps_pings (serie por hora)',
      notes,
    );

    const gpsRow = gps?.[0];
    return {
      generatedAt: new Date().toISOString(),
      windowHours,
      gps: {
        available: gps !== null,
        activeDrivers: gpsRow ? Number(gpsRow.active_drivers) : 0,
        pings: gpsRow ? Number(gpsRow.pings) : 0,
        tripsWithActivity: gpsRow ? Number(gpsRow.trips) : 0,
      },
      tripsPerHour: {
        available: series !== null,
        points: (series ?? []).map((r) => ({ hour: r.hour, trips: Number(r.trips) })),
      },
      notes,
    };
  }

  /** Ejecuta una consulta y, si falla (tabla inexistente / ClickHouse caído), devuelve null + nota. */
  private async safe<T>(fn: () => Promise<T>, source: string, notes: string[]): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn({ err, source }, 'métrica no disponible desde ClickHouse');
      notes.push(`fuente '${source}' no disponible: métrica devuelta en 0/empty`);
      return null;
    }
  }
}
