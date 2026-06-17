/**
 * Puerto + adaptador Prisma de las stats del dashboard admin (KPIs reales de trip-service). Clean arch:
 * el AnalyticsService depende de la INTERFAZ (TRIP_STATS_REPO), no de Prisma. Todos los conteos son
 * agregaciones del lado del motor (count / aggregate / date_trunc por groupBy), NUNCA N+1: no se cargan
 * filas para contar en memoria. Solo datos de trip-service (sin cross-service).
 */
import { Injectable } from '@nestjs/common';
import { type TripsPerHourBucket } from '@veo/shared-types';
import { Prisma, TripStatus } from '../generated/prisma';
import { PrismaService } from '../infra/prisma.service';

// Contrato compartido productor(trip-service)↔consumidor(admin-bff): TripsPerHourBucket vive en
// @veo/shared-types (junto a TripStatsView). Se re-exporta acá por compatibilidad con los imports
// internos que lo tomaban del repo (mismo patrón que EnergySourcePrice).
export type { TripsPerHourBucket };

/** Token DI del puerto (inyección por interfaz). */
export const TRIP_STATS_REPO = Symbol('TRIP_STATS_REPO');

/**
 * Estados "en vuelo AHORA": el viaje está aceptado y en curso hacia/durante el recojo. Derivados del
 * enum tipado de Prisma (NO strings mágicos). Excluye los pre-aceptación (REQUESTED/ASSIGNED/SCHEDULED/
 * REASSIGNING) y todos los terminales (COMPLETED/cancelados/EXPIRED/FAILED).
 */
export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = [
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
  TripStatus.IN_PROGRESS,
] as const;

/** Estados de cancelación (pasajero Y conductor). */
export const CANCELLED_TRIP_STATUSES: readonly TripStatus[] = [
  TripStatus.CANCELLED_BY_PASSENGER,
  TripStatus.CANCELLED_BY_DRIVER,
] as const;

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface TripStatsRepository {
  /** Cantidad de viajes en un estado "en vuelo" AHORA. */
  countActive(): Promise<number>;
  /** COMPLETED con completedAt >= `since`. */
  countCompletedSince(since: Date): Promise<number>;
  /** Cancelados (pasajero o conductor) con cancelledAt >= `since`. */
  countCancelledSince(since: Date): Promise<number>;
  /** Promedio de durationSeconds de los viajes activos; null si no hay activos. */
  avgActiveDurationSeconds(): Promise<number | null>;
  /** Viajes creados por hora (created_at truncado a la hora UTC) desde `since`, orden asc. */
  tripsPerHourSince(since: Date): Promise<TripsPerHourBucket[]>;
}

@Injectable()
export class PrismaTripStatsRepository implements TripStatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  countActive(): Promise<number> {
    return this.prisma.read.trip.count({
      where: { status: { in: [...ACTIVE_TRIP_STATUSES] } },
    });
  }

  countCompletedSince(since: Date): Promise<number> {
    return this.prisma.read.trip.count({
      where: { status: TripStatus.COMPLETED, completedAt: { gte: since } },
    });
  }

  countCancelledSince(since: Date): Promise<number> {
    return this.prisma.read.trip.count({
      where: { status: { in: [...CANCELLED_TRIP_STATUSES] }, cancelledAt: { gte: since } },
    });
  }

  async avgActiveDurationSeconds(): Promise<number | null> {
    const agg = await this.prisma.read.trip.aggregate({
      where: { status: { in: [...ACTIVE_TRIP_STATUSES] } },
      _avg: { durationSeconds: true },
    });
    return agg._avg.durationSeconds;
  }

  async tripsPerHourSince(since: Date): Promise<TripsPerHourBucket[]> {
    // Histograma por hora en UNA query: date_trunc agrupa del lado de Postgres (sin N+1, sin cargar
    // filas a memoria). El cast a timestamptz fija el truncado en UTC; el ISO sale en Z.
    const rows = await this.prisma.read.$queryRaw<{ bucket: Date; trips: bigint }[]>(Prisma.sql`
      SELECT date_trunc('hour', "requested_at" AT TIME ZONE 'UTC') AS bucket, COUNT(*) AS trips
      FROM "trip"."trips"
      WHERE "requested_at" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);
    return rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      trips: Number(r.trips),
    }));
  }
}
