/**
 * TripQueryRepository — ÚNICO punto de acceso Prisma del lado de LECTURA del viaje (CQRS · esquema
 * 'trip'). Espeja los repos de trip-service (analytics/catalog): el TripQueryService depende de este repo
 * por DI y nunca toca `this.prisma`. Sin mutaciones ni outbox.
 *
 * Fuente Prisma por método (se CONSERVA el comportamiento previo): `findByIdOnPrimary` lee del PRIMARIO
 * (read-after-write del detalle, como el viejo mustFind); el resto lee de la RÉPLICA. El WHERE del keyset
 * y el orden lo aporta el service (dominio `history`); el repo solo ejecuta.
 */
import { Injectable } from '@nestjs/common';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import type { Prisma, Trip } from '../generated/prisma';

@Injectable()
export class TripQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Detalle del viaje leído del PRIMARIO (read-after-write, como el viejo mustFind). */
  findByIdOnPrimary(id: string): Promise<Trip | null> {
    return this.prisma.write.trip.findUnique({ where: { id } });
  }

  /** `{ id, status }` del viaje (réplica). */
  findStatusById(id: string): Promise<{ id: string; status: TripStatus } | null> {
    return this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
  }

  /** Viajes PROGRAMADOS de un pasajero, ascendente por hora programada (réplica). */
  findScheduledByPassenger(passengerId: string): Promise<Trip[]> {
    return this.prisma.read.trip.findMany({
      where: { passengerId, status: TripStatus.SCHEDULED },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  /**
   * Página keyset del historial (réplica): el `where` (passengerId/driverId + cursor) lo arma el dominio
   * `history` y lo pasa el service; el orden (requestedAt DESC, id DESC) y el `take` (peek) son fijos.
   */
  findHistoryPage(where: Prisma.TripWhereInput, take: number): Promise<Trip[]> {
    return this.prisma.read.trip.findMany({
      where,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /** El viaje COMPLETED más antiguo del pasajero aún sin cerrar (cola de cierres pendientes). Réplica. */
  findOldestPendingSettlement(passengerId: string): Promise<Trip | null> {
    return this.prisma.read.trip.findFirst({
      where: { passengerId, status: TripStatus.COMPLETED, passengerClosedAt: null },
      orderBy: { completedAt: 'asc' },
    });
  }
}
