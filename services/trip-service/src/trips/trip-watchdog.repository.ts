/**
 * TripWatchdogRepository — ÚNICO punto de acceso Prisma del sweeper de viajes ESTANCADOS (esquema
 * 'trip'). Unit-of-work al estilo de `drivers.repository.ts`: `runInTransaction(work)` + métodos
 * tx-scoped. La DECISIÓN de dominio (selección de candidatos, `resolveStalledTarget`, `assertTransition`,
 * cálculo de `staleMinutes`, emisión de eventos) vive ENTERA en el service; el repo solo ejecuta el acceso
 * a datos y CRISTALIZA el guard de carrera del CAS (`status = <estado observado>` en el WHERE).
 */
import { Injectable } from '@nestjs/common';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import type { Prisma, Trip } from '../generated/prisma';

/** Handle de transacción opaco para el service. */
export type TripTx = Prisma.TransactionClient;

/** Snapshot mínimo del viaje que consumen el pre-filtro y la decisión del sweeper (sin recargar la fila). */
export type WatchdogSnapshot = Pick<
  Trip,
  'id' | 'status' | 'passengerId' | 'driverId' | 'updatedAt'
>;

@Injectable()
export class TripWatchdogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Candidatos NO terminales con `updatedAt <= staleBefore` (pre-filtro barato; réplica). Los `watchedStates`
   * y el corte los aporta el dominio (`WATCHED_STATES`); el filtrado fino por estado lo hace el service.
   */
  findStalledCandidates(
    watchedStates: readonly TripStatus[],
    staleBefore: Date,
    limit: number,
  ): Promise<WatchdogSnapshot[]> {
    return this.prisma.read.trip.findMany({
      where: { status: { in: [...watchedStates] }, updatedAt: { lte: staleBefore } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, status: true, passengerId: true, driverId: true, updatedAt: true },
    });
  }

  /** Snapshot fresco de UN viaje (réplica) para recalcular el target con el reloj actual. */
  findWatchdogSnapshot(id: string): Promise<WatchdogSnapshot | null> {
    return this.prisma.read.trip.findUnique({
      where: { id },
      select: { id: true, status: true, passengerId: true, driverId: true, updatedAt: true },
    });
  }

  /** Dueño del `$transaction` (write · unit-of-work). */
  runInTransaction<T>(work: (tx: TripTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /**
   * CAS del barrido: mueve el viaje a `to` SOLO si SIGUE en el estado observado (`status: fromStatus` en el
   * WHERE, HARDCODEADO). count===0 ⇒ otro tick/endpoint ya lo movió → el service trata como no-op.
   */
  casGuardedStatusUpdate(
    tx: TripTx,
    id: string,
    fromStatus: TripStatus,
    to: TripStatus,
  ): Promise<{ count: number }> {
    return tx.trip.updateMany({ where: { id, status: fromStatus }, data: { status: to } });
  }
}
