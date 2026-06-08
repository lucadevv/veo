/**
 * TripSnapshotService — mantiene el read-model del viaje a partir de eventos consumidos
 * (trip.started, panic.triggered). Es la ÚNICA fuente que alimenta la página pública: share-service
 * no consulta tablas de otros servicios.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

@Injectable()
export class TripSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /** trip.started → el viaje está en curso. */
  async onTripStarted(tripId: string, driverId: string, startedAt: Date): Promise<void> {
    await this.prisma.write.tripSnapshot.upsert({
      where: { tripId },
      create: { tripId, status: 'IN_PROGRESS', driverId, startedAt },
      update: { status: 'IN_PROGRESS', driverId, startedAt },
    });
  }

  /** panic.triggered → guarda pasajero, marca pánico y registra la ubicación aproximada. */
  async onPanic(
    tripId: string,
    passengerId: string,
    geo: { lat: number; lon: number },
    at: Date,
  ): Promise<void> {
    await this.prisma.write.tripSnapshot.upsert({
      where: { tripId },
      create: {
        tripId,
        status: 'PANIC',
        passengerId,
        lastLat: geo.lat,
        lastLon: geo.lon,
        lastLocationAt: at,
      },
      update: {
        status: 'PANIC',
        passengerId,
        lastLat: geo.lat,
        lastLon: geo.lon,
        lastLocationAt: at,
      },
    });
  }
}
