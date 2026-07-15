/**
 * Puerto + adaptador Prisma del read-model TripSnapshot (FOUNDATION §10: el repositorio es el ÚNICO
 * dueño de Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde del PanicRepository
 * (token DI Symbol + interfaz + adaptador con read/write split + `runInTx`).
 *
 * `onTripStarted` es un upsert atómico simple (sin tx). Las 2 proyecciones sensibles a concurrencia
 * (`onPanic`, `onPanicResolved`) leen-y-escriben dentro de UNA transacción: el CUERPO (captura del
 * prePanicStatus + upsert/update) SIGUE viviendo en el service, que recibe el cliente de transacción
 * tipado como `Prisma.TransactionClient`.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type TripSnapshot } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const TRIP_SNAPSHOT_REPO = Symbol('TRIP_SNAPSHOT_REPO');

/** Puerto: el TripSnapshotService depende de esto, NO de Prisma. */
export interface TripSnapshotRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (lectura del
   * estado previo + upsert/update, consistente dentro de la MISMA tx) vive en el service.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Upsert atómico del snapshot (write); el service arma los datos (create/update) del evento trip.started. */
  upsert(args: Prisma.TripSnapshotUpsertArgs): Promise<TripSnapshot>;
}

@Injectable()
export class PrismaTripSnapshotRepository implements TripSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  upsert(args: Prisma.TripSnapshotUpsertArgs): Promise<TripSnapshot> {
    return this.prisma.write.tripSnapshot.upsert(args);
  }
}
