/**
 * DriverTripsRepository — ÚNICO punto de acceso Prisma del HARD purge en cascada de los VIAJES de un
 * conductor (esquema 'trip'). Espeja el patrón unit-of-work de `drivers.repository.ts`: expone
 * `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx` opaco. La
 * LÓGICA (guard de cero viajes, conteo honesto por tabla, orden de borrado dependientes→trip) vive ENTERA
 * en el service; el repo solo ejecuta el acceso a datos.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { Prisma } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo. */
export type TripTx = Prisma.TransactionClient;

@Injectable()
export class DriverTripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Dueño del `$transaction` (write · unit-of-work). El service orquesta la secuencia dentro de `work`. */
  runInTransaction<T>(work: (tx: TripTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /**
   * Cuenta los viajes del conductor (`Trip.driverId = driverId`) — guard del HARD purge en el admin-bff:
   * un conductor con historial operativo NO se purga. `count` del lado del motor (sin cargar filas), read
   * réplica (el guard tolera el lag: un viaje recién creado no cambia el veredicto "tuvo actividad").
   */
  countTripsByDriver(driverId: string): Promise<number> {
    return this.prisma.read.trip.count({ where: { driverId } });
  }

  /** Ids de los viajes del conductor, DENTRO de la tx (para contar dependientes y borrar explícito). */
  findTripIdsByDriverTx(tx: TripTx, driverId: string): Promise<{ id: string }[]> {
    return tx.trip.findMany({ where: { driverId }, select: { id: true } });
  }

  /** Cuenta los trip_events de esos viajes, DENTRO de la tx (el cascade no reporta filas tocadas). */
  countTripEventsByTripIdsTx(tx: TripTx, tripIds: string[]): Promise<number> {
    return tx.tripEvent.count({ where: { tripId: { in: tripIds } } });
  }

  /** Cuenta las propuestas de parada de esos viajes, DENTRO de la tx. */
  countWaypointProposalsByTripIdsTx(tx: TripTx, tripIds: string[]): Promise<number> {
    return tx.tripWaypointProposal.count({ where: { tripId: { in: tripIds } } });
  }

  /** Borra los trip_events de esos viajes, DENTRO de la tx (idempotente). */
  deleteTripEventsByTripIdsTx(tx: TripTx, tripIds: string[]): Promise<{ count: number }> {
    return tx.tripEvent.deleteMany({ where: { tripId: { in: tripIds } } });
  }

  /** Borra las propuestas de parada de esos viajes, DENTRO de la tx (idempotente). */
  deleteWaypointProposalsByTripIdsTx(tx: TripTx, tripIds: string[]): Promise<{ count: number }> {
    return tx.tripWaypointProposal.deleteMany({ where: { tripId: { in: tripIds } } });
  }

  /** Borra los viajes del conductor, DENTRO de la tx. Devuelve el contador honesto de filas borradas. */
  deleteTripsByDriverTx(tx: TripTx, driverId: string): Promise<{ count: number }> {
    return tx.trip.deleteMany({ where: { driverId } });
  }
}
