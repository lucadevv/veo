/**
 * Puerto + adaptador Prisma del feature `events/catalog-operability` (FOUNDATION §10: el repositorio es el
 * ÚNICO dueño de Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde de panic/media
 * (token DI + interfaz + adaptador, `runInTx`).
 *
 * Las lecturas (estado singleton, páginas de vehículos afectados) y el upsert del estado son métodos del
 * puerto, con la query Prisma movida TAL CUAL adentro. Las DOS transacciones (emisión de suspensiones/
 * reincorporaciones por lote) se abren con `runInTx`: el CUERPO transaccional —el `enqueueOutbox` por
 * conductor en la MISMA tx (FOUNDATION §6)— SIGUE en el service, que recibe el cliente tx tipado
 * `Prisma.TransactionClient` (el real, exige el delegate `outboxEvent` completo).
 */
import { Injectable } from '@nestjs/common';
import { VehicleClass } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type CatalogOperableState, type Vehicle } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const CATALOG_OPERABILITY_REPO = Symbol('CATALOG_OPERABILITY_REPO');

/** Id fijo del singleton del estado delta (una sola fila; el catálogo es global). */
const STATE_ID = 'GLOBAL';

/** Candidato de la primera pasada: vehículo de las clases objetivo con conductor (select {id, driverId}). */
export type CatalogVehicleCandidate = Pick<Vehicle, 'id' | 'driverId'>;

/** Proyección para resolver el vehículo OPERADO del conductor (`pickActiveVehicle`). */
export type OperableVehicleProjection = Pick<
  Vehicle,
  'driverId' | 'vehicleType' | 'docStatus' | 'selectedAt' | 'createdAt'
>;

/** Puerto: el CatalogOperabilityService depende de esto, NO de Prisma. */
export interface CatalogOperabilityRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (enqueueOutbox por
   * conductor en la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /** Estado delta persistido (singleton). `null` si nunca se procesó un evento (baseline = default de código). */
  findState(): Promise<CatalogOperableState | null>;
  /** Upsert del singleton (version monotónica + set operable). */
  upsertState(version: number, operableClasses: VehicleClass[]): Promise<void>;

  /**
   * Página (keyset por id, `id asc`, `take`) de vehículos de las `classes` dadas CON conductor — candidatos
   * cuyo dueño puede verse afectado (select {id, driverId}).
   */
  findVehiclesOfClassesPage(
    classes: VehicleClass[],
    take: number,
    cursorId?: string,
  ): Promise<CatalogVehicleCandidate[]>;

  /**
   * TODOS los vehículos de los conductores dados (incluye otras clases): `pickActiveVehicle` elige el operado.
   * Proyección mínima {driverId, vehicleType, docStatus, selectedAt, createdAt}.
   */
  findVehiclesByDrivers(userIds: string[]): Promise<OperableVehicleProjection[]>;
}

@Injectable()
export class PrismaCatalogOperabilityRepository implements CatalogOperabilityRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findState(): Promise<CatalogOperableState | null> {
    return this.prisma.read.catalogOperableState.findUnique({ where: { id: STATE_ID } });
  }

  async upsertState(version: number, operableClasses: VehicleClass[]): Promise<void> {
    await this.prisma.write.catalogOperableState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, version, operableClasses },
      update: { version, operableClasses },
    });
  }

  findVehiclesOfClassesPage(
    classes: VehicleClass[],
    take: number,
    cursorId?: string,
  ): Promise<CatalogVehicleCandidate[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId: { not: null }, vehicleType: { in: classes } },
      select: { id: true, driverId: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  findVehiclesByDrivers(userIds: string[]): Promise<OperableVehicleProjection[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId: { in: userIds } },
      select: {
        driverId: true,
        vehicleType: true,
        docStatus: true,
        selectedAt: true,
        createdAt: true,
      },
    });
  }
}
