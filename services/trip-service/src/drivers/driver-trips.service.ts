/**
 * DriverTripsService — lógica del HARD purge en cascada de los VIAJES de un conductor (DEV-only,
 * orquestado por el admin-bff con el guard de historial aguas arriba). Borra REALMENTE, en UNA
 * transacción, todo el rastro de viajes del conductor SIN dejar huérfanos.
 *
 * INVARIANTE DE ID (verificado contra la DB real): `Trip.driverId` = id de PERFIL Driver de identity
 * (el MISMO `:id` de la ruta de ops del admin-bff y del trip-count). NO es el userId.
 *
 * DEPENDIENTES DEL VIAJE: `TripEvent` y `TripWaypointProposal` referencian el Trip con
 * `onDelete: Cascade` (FK física en la migración). Postgres los borra en cascada al borrar el Trip, así
 * que un `deleteMany` de trips arrastra sus eventos y propuestas SIN dejar filas huérfanas. Igual los
 * CONTAMOS antes (en la misma tx) para devolver contadores honestos por tabla — el cascade no reporta
 * cuántas filas tocó, y el resumen del purge necesita decir la verdad de lo que se borró.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Contadores por tabla del HARD purge de viajes de un conductor (observabilidad/degradación honesta). */
export interface DriverTripsPurgeView {
  driverId: string;
  trips: number;
  tripEvents: number;
  waypointProposals: number;
}

@Injectable()
export class DriverTripsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Borra TODOS los viajes del conductor (`Trip.driverId = driverId`) y sus dependientes, en UNA
   * transacción. Idempotente: re-correr sobre un conductor ya purgado devuelve contadores en 0
   * (deleteMany no falla sin filas). NO emite eventos: es un borrado administrativo de data de prueba
   * (DEV), no un hecho de dominio del ciclo de vida del viaje.
   */
  async purgeForDriver(driverId: string): Promise<DriverTripsPurgeView> {
    return this.prisma.write.$transaction(async (tx) => {
      // Ids de los viajes del conductor: necesarios para CONTAR los dependientes (el cascade físico los
      // borra solo, pero no reporta cuántos) y, si no hubiera cascade, para borrarlos explícito.
      const trips = await tx.trip.findMany({ where: { driverId }, select: { id: true } });
      const tripIds = trips.map((t) => t.id);

      if (tripIds.length === 0) {
        return { driverId, trips: 0, tripEvents: 0, waypointProposals: 0 };
      }

      const [tripEvents, waypointProposals] = await Promise.all([
        tx.tripEvent.count({ where: { tripId: { in: tripIds } } }),
        tx.tripWaypointProposal.count({ where: { tripId: { in: tripIds } } }),
      ]);

      // Borramos los dependientes EXPLÍCITO antes del Trip: el contador es honesto y no dependemos de que
      // el cascade físico esté presente en cada entorno (defensa en profundidad; en DB con cascade es no-op
      // de filas ya idas, pero acá las sacamos nosotros primero — el deleteMany es idempotente).
      await tx.tripEvent.deleteMany({ where: { tripId: { in: tripIds } } });
      await tx.tripWaypointProposal.deleteMany({ where: { tripId: { in: tripIds } } });
      const deletedTrips = await tx.trip.deleteMany({ where: { driverId } });

      return {
        driverId,
        trips: deletedTrips.count,
        tripEvents,
        waypointProposals,
      };
    });
  }
}
