/**
 * Puerto + adaptador Prisma del feature `expirations/` — dueño del acceso Prisma del ExpirySweeper (cron de
 * vencimientos). FOUNDATION §10: ningún *.sweeper.ts toca `this.prisma` directo. Espeja el molde de media,
 * donde el repo del feature absorbió el sweeper/worker que lo acompañan.
 *
 * El sweeper es CROSS-FEATURE por naturaleza (recalcula documentos, agrega el docStatus del vehículo y suspende
 * por ITV), así que su repo propio posee las lecturas paginadas de `fleetDocument`/`vehicle`/`inspection` y los
 * writes de recálculo — en vez de repartir consultas cron-específicas por los repos de cada feature. Las TRES
 * transacciones (processDocument · recomputeVehicles · suspendByInspection) se abren con `runInTx`: el CUERPO
 * (update + `outboxEvent.create` en la MISMA tx, FOUNDATION §6) SIGUE en el sweeper, que recibe el cliente tx
 * tipado `Prisma.TransactionClient` (el real).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { VEHICLE_REQUIRED_DOCUMENT_TYPES } from '../vehicles/vehicle-rules';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  type FleetDocument,
  type Inspection,
  type Vehicle,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const EXPIRATIONS_REPO = Symbol('EXPIRATIONS_REPO');

/** Vehículo con conductor (select mínimo del pase de ITV). */
export type DriverVehicleRef = Pick<Vehicle, 'id' | 'driverId'>;

/** Estado documental REQUERIDO por vehículo (select del recálculo de docStatus). */
export type RequiredDocStatus = Pick<FleetDocument, 'ownerId' | 'status'>;

/** Puerto: el ExpirySweeper depende de esto, NO de Prisma. */
export interface ExpirationsRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (update + outbox en la
   * MISMA tx) vive en el sweeper; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /**
   * Página (keyset por id, `id asc`, `take`) de documentos con vencimiento en un estado recalculable
   * (VALID/EXPIRING_SOON/EXPIRED).
   */
  findExpirableDocumentsPage(take: number, cursorId?: string): Promise<FleetDocument[]>;

  /** Página (keyset por id) de vehículos CON conductor (select {id, driverId}) — pase de ITV. */
  findVehiclesWithDriverPage(take: number, cursorId?: string): Promise<DriverVehicleRef[]>;

  /** TODOS los vehículos (completos) de los conductores dados — resolución del operado (`pickActiveVehicle`). */
  findVehiclesByDrivers(userIds: string[]): Promise<Vehicle[]>;

  /** Inspecciones de los vehículos dados (read, `inspectedAt desc`) — la última por vehículo la elige el sweeper. */
  findInspectionsForVehicles(vehicleIds: string[]): Promise<Inspection[]>;

  /** Página (keyset por id) de TODOS los vehículos (completos) — recálculo de docStatus. */
  findVehiclesPage(take: number, cursorId?: string): Promise<Vehicle[]>;

  /**
   * Documentos REQUERIDOS (SOAT/ITV) recalculables de los vehículos dados (select {ownerId, status}) — agregación
   * del docStatus del vehículo (anti-N+1).
   */
  findVehicleRequiredDocs(vehicleIds: string[]): Promise<RequiredDocStatus[]>;
}

@Injectable()
export class PrismaExpirationsRepository implements ExpirationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findExpirableDocumentsPage(take: number, cursorId?: string): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: {
        expiresAt: { not: null },
        status: {
          in: [
            FleetDocumentStatus.VALID,
            FleetDocumentStatus.EXPIRING_SOON,
            FleetDocumentStatus.EXPIRED,
          ],
        },
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  findVehiclesWithDriverPage(take: number, cursorId?: string): Promise<DriverVehicleRef[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId: { not: null } },
      select: { id: true, driverId: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  findVehiclesByDrivers(userIds: string[]): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId: { in: userIds } },
    });
  }

  findInspectionsForVehicles(vehicleIds: string[]): Promise<Inspection[]> {
    return this.prisma.read.inspection.findMany({
      where: { vehicleId: { in: vehicleIds } },
      orderBy: { inspectedAt: 'desc' },
    });
  }

  findVehiclesPage(take: number, cursorId?: string): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  findVehicleRequiredDocs(vehicleIds: string[]): Promise<RequiredDocStatus[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: {
        ownerType: FleetOwnerType.VEHICLE,
        ownerId: { in: vehicleIds },
        type: { in: [...VEHICLE_REQUIRED_DOCUMENT_TYPES] },
        status: {
          in: [
            FleetDocumentStatus.VALID,
            FleetDocumentStatus.EXPIRING_SOON,
            FleetDocumentStatus.EXPIRED,
          ],
        },
      },
      select: { ownerId: true, status: true },
    });
  }
}
