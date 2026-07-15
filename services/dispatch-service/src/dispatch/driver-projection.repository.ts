/**
 * Puerto + adaptador Prisma de DriverProjectionService (FOUNDATION §10). Dueño del acceso a `DriverStats`
 * y `DriverCancellationEvent` (la proyección LOCAL del scoring). Las transacciones de dominio (media móvil
 * de rating, contador de completados, ventana rolling de cancelaciones con advisory lock + poda + outbox)
 * se abren con `runInTx`: el CUERPO —incluido el `pg_advisory_xact_lock`, el `createMany` idempotente y el
 * `outboxEvent.create` de la MISMA tx (FOUNDATION §6)— SIGUE en el service. El tx se tipa como el real
 * `Prisma.TransactionClient` (usa `$executeRaw` + varios delegates + outbox).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type DriverStats } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const DRIVER_PROJECTION_REPO = Symbol('DRIVER_PROJECTION_REPO');

/** Puerto: el DriverProjectionService depende de esto, NO de Prisma. */
export interface DriverProjectionRepository {
  /** Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo vive en el service. */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Impone el rating promedio recalculado (driver.flagged): upsert directo, sin tx. */
  upsertDriverAvgRating(driverId: string, avgRating: number): Promise<void>;
  /** Lee las stats de varios conductores (read); las normaliza el service. */
  findStats(driverIds: string[]): Promise<DriverStats[]>;
}

@Injectable()
export class PrismaDriverProjectionRepository implements DriverProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  async upsertDriverAvgRating(driverId: string, avgRating: number): Promise<void> {
    await this.prisma.write.driverStats.upsert({
      where: { driverId },
      create: { driverId, avgRating },
      update: { avgRating },
    });
  }

  findStats(driverIds: string[]): Promise<DriverStats[]> {
    return this.prisma.read.driverStats.findMany({ where: { driverId: { in: driverIds } } });
  }
}
