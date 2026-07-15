/**
 * Puerto + adaptador Prisma del feature `vehicles/` (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde de panic/media (token DI +
 * interfaz + adaptador, cliente dual read/write, `runInTx`).
 *
 * Las lecturas y las escrituras de un solo statement son métodos del puerto (con la query Prisma movida TAL
 * CUAL adentro). Las DOS transacciones del feature (purge del conductor · alta self-service con outbox) se
 * abren con `runInTx`: el CUERPO transaccional de dominio SIGUE viviendo en el service, que recibe el cliente
 * de transacción tipado `Prisma.TransactionClient` (el real) — los cuerpos combinan mutaciones sobre `vehicle`/
 * `fleetDocument` con `outboxEvent.create`, que exige el delegate completo; un puerto estrecho re-implementaría
 * a mano los tipos de Prisma sin ganancia.
 *
 * El feature `vehicles/` lee además del catálogo (`vehicleModelSpec`, ficha técnica) y de los documentos del
 * vehículo/conductor (`fleetDocument`, operabilidad): son lecturas que HACE este service, así que su acceso
 * Prisma es de este repo (igual que media absorbió los dos modelos que su feature entrelaza).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import {
  FleetOwnerType,
  Prisma,
  VehicleModelStatus,
  type FleetDocument,
  type Vehicle,
  type VehicleModelSpec,
  type VehicleDocStatus,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const VEHICLES_REPO = Symbol('VEHICLES_REPO');

/** Puerto: el VehiclesService depende de esto, NO de Prisma. */
export interface VehiclesRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (mutaciones + outbox en
   * la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  // ── Catálogo de modelos (read) ─────────────────────────────────────────────────────────────────────
  /** Modelo del catálogo APPROVED por id (read). `null` si no existe o no está aprobado. */
  findApprovedModelSpec(id: string): Promise<VehicleModelSpec | null>;
  /** Modelo del catálogo por id, cualquier estado (read). `null` si no existe. */
  findModelSpecById(id: string): Promise<VehicleModelSpec | null>;
  /** Modelos del catálogo por ids (read) — enriquecimiento batcheado (anti-N+1). */
  findModelSpecsByIds(ids: string[]): Promise<VehicleModelSpec[]>;

  // ── Vehículos (read) ───────────────────────────────────────────────────────────────────────────────
  /** Vehículo por placa desde la RÉPLICA (read). `null` si no existe. */
  findByPlate(plate: string): Promise<Vehicle | null>;
  /** Vehículo por placa desde el PRIMARIO (write) — re-resolución del dueño tras un P2002 de carrera. */
  findByPlateOnPrimary(plate: string): Promise<Vehicle | null>;
  /** Vehículo por id desde la réplica (read). `null` si no existe. */
  findById(id: string): Promise<Vehicle | null>;
  /** Todos los vehículos de un conductor (read), sin orden. */
  findByDriver(driverId: string): Promise<Vehicle[]>;
  /**
   * Todos los vehículos de un conductor desde el PRIMARIO (write): READ-YOUR-WRITES del vehículo operado
   * (`pickActiveVehicle` decide por `selectedAt`, el mismo campo que escribe setActiveVehicle en write).
   */
  findByDriverOnPrimary(driverId: string): Promise<Vehicle[]>;
  /** Vehículos de un conductor (read), más recientes primero (`createdAt desc`). */
  findByDriverRecent(driverId: string): Promise<Vehicle[]>;
  /** Página de la flota admin por keyset de id (read, `id desc`, `take`). Filtro opcional por docStatus. */
  listPage(opts: { docStatus?: VehicleDocStatus; cursor?: string; take: number }): Promise<Vehicle[]>;

  // ── Vehículos (write) ──────────────────────────────────────────────────────────────────────────────
  /** Alta de un vehículo (write, alta admin). */
  create(data: Prisma.VehicleCreateInput): Promise<Vehicle>;
  /** Actualiza un vehículo por id (write). */
  update(id: string, data: Prisma.VehicleUpdateInput): Promise<Vehicle>;

  // ── Documentos (read) ──────────────────────────────────────────────────────────────────────────────
  /** Documentos de UN vehículo (read, ownerType=VEHICLE). */
  findVehicleDocs(vehicleId: string): Promise<FleetDocument[]>;
  /** Documentos de VARIOS vehículos en UNA query (read, ownerType=VEHICLE, anti-N+1). */
  findVehicleDocsForOwners(vehicleIds: readonly string[]): Promise<FleetDocument[]>;
  /** Certificaciones/documentos DRIVER-scoped de un conductor (read, ownerType=DRIVER). */
  findDriverDocs(driverId: string): Promise<FleetDocument[]>;
}

@Injectable()
export class PrismaVehiclesRepository implements VehiclesRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findApprovedModelSpec(id: string): Promise<VehicleModelSpec | null> {
    return this.prisma.read.vehicleModelSpec.findFirst({
      where: { id, status: VehicleModelStatus.APPROVED },
    });
  }

  findModelSpecById(id: string): Promise<VehicleModelSpec | null> {
    return this.prisma.read.vehicleModelSpec.findUnique({ where: { id } });
  }

  findModelSpecsByIds(ids: string[]): Promise<VehicleModelSpec[]> {
    return this.prisma.read.vehicleModelSpec.findMany({ where: { id: { in: ids } } });
  }

  findByPlate(plate: string): Promise<Vehicle | null> {
    return this.prisma.read.vehicle.findUnique({ where: { plate } });
  }

  findByPlateOnPrimary(plate: string): Promise<Vehicle | null> {
    return this.prisma.write.vehicle.findUnique({ where: { plate } });
  }

  findById(id: string): Promise<Vehicle | null> {
    return this.prisma.read.vehicle.findUnique({ where: { id } });
  }

  findByDriver(driverId: string): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({ where: { driverId } });
  }

  findByDriverOnPrimary(driverId: string): Promise<Vehicle[]> {
    return this.prisma.write.vehicle.findMany({ where: { driverId } });
  }

  findByDriverRecent(driverId: string): Promise<Vehicle[]> {
    return this.prisma.read.vehicle.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
    });
  }

  listPage(opts: { docStatus?: VehicleDocStatus; cursor?: string; take: number }): Promise<Vehicle[]> {
    const where: Prisma.VehicleWhereInput = {};
    if (opts.docStatus) where.docStatus = opts.docStatus;
    if (opts.cursor) where.id = { lt: opts.cursor };
    return this.prisma.read.vehicle.findMany({
      where,
      orderBy: { id: 'desc' },
      take: opts.take,
    });
  }

  create(data: Prisma.VehicleCreateInput): Promise<Vehicle> {
    return this.prisma.write.vehicle.create({ data });
  }

  update(id: string, data: Prisma.VehicleUpdateInput): Promise<Vehicle> {
    return this.prisma.write.vehicle.update({ where: { id }, data });
  }

  findVehicleDocs(vehicleId: string): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: vehicleId },
    });
  }

  findVehicleDocsForOwners(vehicleIds: readonly string[]): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: [...vehicleIds] } },
    });
  }

  findDriverDocs(driverId: string): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: driverId },
    });
  }
}
