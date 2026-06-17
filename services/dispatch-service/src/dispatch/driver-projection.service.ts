/**
 * DriverProjectionService — proyección LOCAL de métricas del conductor para el scoring (BR-T06).
 *
 * Decisión de arquitectura (documentada en README/docs/events.md):
 * dispatch NO hace join cross-servicio a las tablas de identity/rating. En su lugar mantiene una
 * proyección propia (`driver_stats`) poblada por eventos de dominio:
 *   - rating.created  → media móvil del rating.
 *   - driver.flagged  → rating promedio recalculado (rollingAvg) impuesto.
 *   - trip.completed  → último viaje + contador de completados (driverId resuelto vía el match aceptado).
 *   - trip.cancelled  → contador de cancelaciones del conductor (para la tasa de cancelación).
 * Así el scoring lee de una fuente local de baja latencia y dispatch queda desacoplado.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Stats normalizadas que consume el scorer. */
export interface DriverScoreStats {
  avgRating: number;
  secondsSinceLastTrip: number;
  cancellationRate: number;
}

/// Segundos atribuidos a un conductor sin viajes registrados (término de actividad ≈ 0).
const NO_TRIP_SECONDS = 1_000_000_000;
const DEFAULT_RATING = 5.0;

@Injectable()
export class DriverProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async onRatingCreated(driverId: string, stars: number): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.driverStats.findUnique({ where: { driverId } });
      const prevCount = existing?.ratingCount ?? 0;
      const prevAvg = existing ? Number(existing.avgRating.toString()) : DEFAULT_RATING;
      const newCount = prevCount + 1;
      const newAvg = (prevAvg * prevCount + stars) / newCount;
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, avgRating: newAvg, ratingCount: 1 },
        update: { avgRating: newAvg, ratingCount: newCount },
      });
    });
  }

  async onDriverFlagged(driverId: string, rollingAvg: number): Promise<void> {
    await this.prisma.write.driverStats.upsert({
      where: { driverId },
      create: { driverId, avgRating: rollingAvg },
      update: { avgRating: rollingAvg },
    });
  }

  async onTripCompleted(driverId: string, completedAt: Date): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.driverStats.findUnique({ where: { driverId } });
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, completedTrips: 1, lastTripAt: completedAt },
        update: { completedTrips: (existing?.completedTrips ?? 0) + 1, lastTripAt: completedAt },
      });
    });
  }

  async onTripCancelledByDriver(driverId: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const existing = await tx.driverStats.findUnique({ where: { driverId } });
      await tx.driverStats.upsert({
        where: { driverId },
        create: { driverId, cancelledTrips: 1 },
        update: { cancelledTrips: (existing?.cancelledTrips ?? 0) + 1 },
      });
    });
  }

  /** Lee stats de varios conductores y las normaliza para el scorer (con defaults para desconocidos). */
  async getStats(driverIds: string[]): Promise<Map<string, DriverScoreStats>> {
    const rows =
      driverIds.length === 0
        ? []
        : await this.prisma.read.driverStats.findMany({ where: { driverId: { in: driverIds } } });
    const now = Date.now();
    const map = new Map<string, DriverScoreStats>();
    for (const r of rows) {
      const completed = r.completedTrips;
      const cancelled = r.cancelledTrips;
      const total = completed + cancelled;
      map.set(r.driverId, {
        avgRating: Number(r.avgRating.toString()),
        secondsSinceLastTrip: r.lastTripAt
          ? Math.max(1, (now - r.lastTripAt.getTime()) / 1000)
          : NO_TRIP_SECONDS,
        cancellationRate: total > 0 ? cancelled / total : 0,
      });
    }
    for (const id of driverIds) {
      if (!map.has(id)) {
        map.set(id, {
          avgRating: DEFAULT_RATING,
          secondsSinceLastTrip: NO_TRIP_SECONDS,
          cancellationRate: 0,
        });
      }
    }
    return map;
  }
}
