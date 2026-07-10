/**
 * Puerto + adaptador Prisma del `TripGrpcController` (FOUNDATION §10: ningún controller/service toca
 * `this.prisma` directo). El gRPC es un LECTOR síncrono del viaje para otros servicios (rehidratación del
 * flujo activo, detalle de "Mis Viajes", pending-settlement, estado): en vez de repartir sus consultas por
 * los repos de cada feature (que sirven a sus services), tiene su propio repo de lectura — mismo criterio
 * que el repo propio del gRPC de fleet.
 *
 * READ-ONLY y ÍNTEGRAMENTE RÉPLICA: no hay `runInTx` ni un eje read/write. Las CINCO lecturas que movió
 * el controller salían todas de `prisma.read` (proyecciones cross-servicio que toleran el lag de réplica),
 * así que NO hace falta el booleano `fresh` del repo de fleet (allá lo pedía el gate de dinero). La única
 * decisión read-write deliberada del controller —NO re-leer de la réplica tras `closeByPassenger` para no
 * ver una fila sin el `passengerClosedAt` recién escrito— vive en el handler, que NO consulta Prisma (mapea
 * el `TripView` que ya devuelve el service): por eso no aterriza acá.
 */
import { Injectable } from '@nestjs/common';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { LIVE_STATES } from '../trips/domain/trip-state-machine';
import type { Trip } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const TRIP_GRPC_REPO = Symbol('TRIP_GRPC_REPO');

/** Estado mínimo del viaje (proyección de GetTripState). */
export type TripStateRef = Pick<Trip, 'id' | 'status'>;

/** Puerto: el TripGrpcController depende de esto, NO de Prisma. */
export interface TripGrpcRepository {
  /** Viaje por id (read réplica). `null` si no existe. */
  findById(id: string): Promise<Trip | null>;
  /** Viaje VIVO del pasajero (LIVE_STATES, `requestedAt desc`). `null` si no tiene ninguno. */
  findActiveByPassenger(passengerId: string): Promise<Trip | null>;
  /** Viaje VIVO del conductor (LIVE_STATES, `requestedAt desc`). `null` si no tiene ninguno. */
  findActiveByDriver(driverId: string): Promise<Trip | null>;
  /**
   * Viaje COMPLETED más VIEJO sin cerrar del pasajero (`passengerClosedAt = null`, `completedAt asc`) —
   * pending-settlement. `null` si no hay ninguno.
   */
  findOldestPendingSettlement(passengerId: string): Promise<Trip | null>;
  /** Estado del viaje por id (read, proyección `{ id, status }`). `null` si no existe. */
  findStateById(id: string): Promise<TripStateRef | null>;
}

@Injectable()
export class PrismaTripGrpcRepository implements TripGrpcRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Trip | null> {
    return this.prisma.read.trip.findUnique({ where: { id } });
  }

  findActiveByPassenger(passengerId: string): Promise<Trip | null> {
    return this.prisma.read.trip.findFirst({
      where: { passengerId, status: { in: [...LIVE_STATES] } },
      orderBy: { requestedAt: 'desc' },
    });
  }

  findActiveByDriver(driverId: string): Promise<Trip | null> {
    return this.prisma.read.trip.findFirst({
      where: { driverId, status: { in: [...LIVE_STATES] } },
      orderBy: { requestedAt: 'desc' },
    });
  }

  findOldestPendingSettlement(passengerId: string): Promise<Trip | null> {
    return this.prisma.read.trip.findFirst({
      where: { passengerId, status: TripStatus.COMPLETED, passengerClosedAt: null },
      orderBy: { completedAt: 'asc' },
    });
  }

  findStateById(id: string): Promise<TripStateRef | null> {
    return this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
  }
}
