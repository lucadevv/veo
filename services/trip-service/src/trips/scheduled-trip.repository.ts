/**
 * ScheduledTripRepository — ÚNICO punto de acceso Prisma de los viajes PROGRAMADOS (esquema 'trip').
 * Unit-of-work al estilo de `drivers.repository.ts`: `runInTransaction(work)` + métodos tx-scoped. La
 * lógica (resolve-once del modo congelado, degradación honesta del catálogo, `assertTransition`, emisión
 * de eventos) vive ENTERA en el service; el repo solo ejecuta el acceso a datos y CRISTALIZA el guard de
 * carrera `status = SCHEDULED` de las transiciones de activación/expiración.
 */
import { Injectable } from '@nestjs/common';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import type { Prisma, Trip } from '../generated/prisma';

/** Handle de transacción opaco para el service. */
export type TripTx = Prisma.TransactionClient;

@Injectable()
export class ScheduledTripRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Viaje por id desde la RÉPLICA (activación por cron; gate barato de idempotencia). */
  findByIdRead(id: string): Promise<Trip | null> {
    return this.prisma.read.trip.findUnique({ where: { id } });
  }

  /** Viaje por id desde el PRIMARIO (mustFind de cancelScheduledTrip: read-after-write). */
  findByIdOnPrimary(id: string): Promise<Trip | null> {
    return this.prisma.write.trip.findUnique({ where: { id } });
  }

  /** Ids de los programados que YA deben activarse (`scheduledFor <= dueBefore`), ascendente. Réplica. */
  async findDueScheduledIds(dueBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.read.trip.findMany({
      where: { status: TripStatus.SCHEDULED, scheduledFor: { lte: dueBefore } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Dueño del `$transaction` (write · unit-of-work). */
  runInTransaction<T>(work: (tx: TripTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /**
   * CAS de la activación/expiración de un programado: aplica `data` SOLO si el viaje SIGUE SCHEDULED
   * (`status: SCHEDULED` HARDCODEADO en el WHERE). count===0 ⇒ otro tick lo activó/canceló → no-op.
   */
  casGuardedScheduledUpdate(
    tx: TripTx,
    id: string,
    data: Prisma.TripUpdateManyMutationInput,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({ where: { id, status: TripStatus.SCHEDULED }, data });
  }

  /** Update por id, DENTRO de la tx (cancelScheduledTrip; el `assertTransition` ya validó fuera). */
  updateByIdTx(tx: TripTx, id: string, data: Prisma.TripUpdateInput): Promise<Trip> {
    return tx.trip.update({ where: { id }, data });
  }
}
