/**
 * Puerto + adaptador Prisma del `FleetGrpcController` (FOUNDATION §10: ningún controller/service toca
 * `this.prisma` directo). El gRPC es un LECTOR cross-feature (proyecciones síncronas de vehículos, documentos,
 * inspecciones y catálogo para identity/admin/dispatch): en vez de repartir sus consultas por los repos de
 * cada feature (que sirven a sus services), tiene su propio repo de lectura — mismo criterio que el repo propio
 * del sweeper. Es READ-ONLY: no hay `runInTx`.
 *
 * FRESHNESS explícita: la lectura del GATE DE DINERO (GetVehicle → reserve/approve del carpooling) DEBE ver el
 * primario (un doc REVOCADO no puede esconderse tras el lag de réplica). Ese eje read-write, que antes viajaba
 * como el parámetro `db`, ahora es el booleano `fresh`: `true` = primario (write), `false` = réplica (read).
 */
import { Injectable } from '@nestjs/common';
import { FleetDocumentType } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  VehicleModelStatus,
  type DocumentImage,
  type FleetDocument,
  type Inspection,
  type Vehicle,
  type VehicleDocStatus,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const FLEET_GRPC_REPO = Symbol('FLEET_GRPC_REPO');

/** Documento con sus imágenes (orden estable) — proyección de los detalles admin. */
export type GrpcDocumentWithImages = FleetDocument & { images: DocumentImage[] };

/** Estado de ITV por vehículo (última inspección, proyección mínima). */
export type GrpcInspectionRef = Pick<Inspection, 'vehicleId' | 'passed' | 'nextDueAt'>;

/** Documento REQUERIDO-en-VALID de un conductor (proyección de completitud). */
export type GrpcDriverDocRef = Pick<FleetDocument, 'ownerId' | 'type'>;

/** Conteo de vehículos por estado documental. */
export type GrpcVehicleDocStatusCount = { docStatus: VehicleDocStatus; count: number };

/** Puerto: el FleetGrpcController depende de esto, NO de Prisma. */
export interface FleetGrpcRepository {
  /** Vehículo por id (read réplica / write primario según `fresh`). `null` si no existe. */
  findVehicleById(id: string, fresh: boolean): Promise<Vehicle | null>;
  /** Documentos de VEHÍCULO de un set de ids (read/write según `fresh`) — cómputo de docsOperable batcheado. */
  findVehicleDocs(vehicleIds: readonly string[], fresh: boolean): Promise<FleetDocument[]>;

  /** Conteo de vehículos por docStatus (groupBy agregado en la réplica). */
  countVehiclesByDocStatus(): Promise<GrpcVehicleDocStatusCount[]>;
  /** Conteo de documentos por estado (read). */
  countDocuments(status: FleetDocumentStatus, ownerType?: FleetOwnerType): Promise<number>;
  /** Conteo de modelos de vehículo por estado (read). */
  countModels(status: VehicleModelStatus): Promise<number>;

  /** Documentos REQUERIDOS-en-VALID de varios conductores en UNA query (read, proyección {ownerId, type}). */
  findDriverValidRequiredDocs(
    driverIds: string[],
    requiredTypes: readonly FleetDocumentType[],
  ): Promise<GrpcDriverDocRef[]>;

  /** Inspecciones de varios vehículos (read, `vehicleId asc, inspectedAt desc`, proyección) — última por vehículo. */
  findInspectionsForVehicles(vehicleIds: string[]): Promise<GrpcInspectionRef[]>;
  /** Última inspección de un vehículo (read, `inspectedAt desc`). `null` si no tiene. */
  findLatestInspection(vehicleId: string): Promise<Inspection | null>;

  /** Documentos de un owner con imágenes (read, `createdAt desc`) — detalle admin. */
  findDocsWithImagesByOwner(
    ownerType: FleetOwnerType,
    ownerId: string,
  ): Promise<GrpcDocumentWithImages[]>;

  /** Vehículos por ids (read). */
  findVehiclesByIds(ids: string[]): Promise<Vehicle[]>;
  /** Vehículos de un conductor (read), más recientes primero. */
  findVehiclesByDriverRecent(driverId: string): Promise<Vehicle[]>;
  /** Vehículos de un conductor (read), sin orden — resolución del operado. */
  findVehiclesByDriver(driverId: string): Promise<Vehicle[]>;
}

@Injectable()
export class PrismaFleetGrpcRepository implements FleetGrpcRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Cliente según freshness: primario (write) para el gate de dinero, réplica (read) para display/batch. */
  private db(fresh: boolean): PrismaService['read'] {
    return fresh ? this.prisma.write : this.prisma.read;
  }

  findVehicleById(id: string, fresh: boolean): Promise<Vehicle | null> {
    return this.db(fresh).vehicle.findUnique({ where: { id } });
  }

  findVehicleDocs(vehicleIds: readonly string[], fresh: boolean): Promise<FleetDocument[]> {
    return this.db(fresh).fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: [...vehicleIds] } },
    });
  }

  async countVehiclesByDocStatus(): Promise<GrpcVehicleDocStatusCount[]> {
    const groups = await this.prisma.read.vehicle.groupBy({
      by: ['docStatus'],
      _count: { _all: true },
    });
    return groups.map((g) => ({ docStatus: g.docStatus, count: g._count._all }));
  }

  countDocuments(status: FleetDocumentStatus, ownerType?: FleetOwnerType): Promise<number> {
    // ownerType opcional: la cola de "Documentos reenviados" del admin es SOLO de conductor (los docs de
    // vehículo se cuentan/muestran en el eje Vehículos). El índice [ownerType, ownerId] cubre el filtro.
    return this.prisma.read.fleetDocument.count({
      where: { status, ...(ownerType ? { ownerType } : {}) },
    });
  }

  countModels(status: VehicleModelStatus): Promise<number> {
    return this.prisma.read.vehicleModelSpec.count({ where: { status } });
  }

  findDriverValidRequiredDocs(
    driverIds: string[],
    requiredTypes: readonly FleetDocumentType[],
  ): Promise<GrpcDriverDocRef[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: {
        ownerType: FleetOwnerType.DRIVER,
        ownerId: { in: driverIds },
        type: { in: [...requiredTypes] },
        status: FleetDocumentStatus.VALID,
      },
      select: { ownerId: true, type: true },
    });
  }

  findInspectionsForVehicles(vehicleIds: string[]): Promise<GrpcInspectionRef[]> {
    return this.prisma.read.inspection.findMany({
      where: { vehicleId: { in: vehicleIds } },
      orderBy: [{ vehicleId: 'asc' }, { inspectedAt: 'desc' }],
      select: { vehicleId: true, passed: true, nextDueAt: true },
    });
  }

  findLatestInspection(vehicleId: string): Promise<Inspection | null> {
    return this.prisma.read.inspection.findFirst({
      where: { vehicleId },
      orderBy: { inspectedAt: 'desc' },
    });
  }

  findDocsWithImagesByOwner(
    ownerType: FleetOwnerType,
    ownerId: string,
  ): Promise<GrpcDocumentWithImages[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerType, ownerId },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { order: 'asc' } } },
    });
  }

  findVehiclesByIds(ids: string[]): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({ where: { id: { in: ids } } });
  }

  findVehiclesByDriverRecent(driverId: string): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findVehiclesByDriver(driverId: string): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({ where: { driverId } });
  }
}
