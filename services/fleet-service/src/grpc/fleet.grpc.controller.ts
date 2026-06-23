/**
 * Controlador gRPC de fleet (paquete veo.fleet.v1.FleetService).
 * Lectura síncrona de vehículos y documentos para otros servicios (identity/admin).
 * Devuelve `found=false` en vez de lanzar, para que el llamante decida.
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import { deriveVehicleReviewStatus, pickActiveVehicle } from '../vehicles/vehicle-rules';
import {
  inspectionInvalidReason,
  isInspectionCurrent,
  InspectionInvalidReason,
} from '../inspections/inspection-rules';
import { FleetOwnerType, type Vehicle } from '../generated/prisma';
import type { Env } from '../config/env.schema';

interface GetByIdRequest {
  id: string;
}

interface VehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  /// Ola 2B · tier moto-taxi: tipo de vehículo (CAR|MOTO).
  vehicleType: string;
  docStatus: string;
  active: boolean;
  found: boolean;
  /// Estado de revisión derivado (PENDING_REVIEW|ACTIVE) para el onboarding self-service.
  status: string;
}

interface DriverVehiclesReply {
  driverId: string;
  vehicles: VehicleReply[];
}

/// Imagen de un documento (sub-lote 3A): clave S3 + cara (FRONT|BACK|SINGLE) + orden.
interface DocumentImageReply {
  s3Key: string;
  side: string;
  order: number;
}

interface FleetDocumentReply {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  documentNumber: string;
  status: string;
  expiresAt: string;
  /// DEPRECADO (sub-lote 3A): primera imagen (backward-compat). El driver-bff NO lo proyecta al conductor.
  fileS3Key: string;
  rejectionReason: string;
  /// Imágenes del documento (1..N caras). Admin review las firma; el driver-bff mapea un subconjunto.
  images: DocumentImageReply[];
}

interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}

/// Vigencia de la ITV del vehículo OPERADO del conductor (gate de aprobación · compliance).
interface DriverInspectionStatusReply {
  current: boolean;
  hasVehicle: boolean;
  vehicleId: string;
  plate: string;
  nextDueAt: string;
  passed: boolean;
  /// NONE|NOT_PASSED|OVERDUE|NO_VEHICLE; "" cuando current=true.
  invalidReason: string;
}

/// Motivo extra (fuera del enum de inspección): el conductor no tiene NINGÚN vehículo operable.
const NO_VEHICLE_REASON = 'NO_VEHICLE';

const EMPTY_VEHICLE: VehicleReply = {
  id: '',
  plate: '',
  make: '',
  model: '',
  year: 0,
  color: '',
  vehicleType: '',
  docStatus: '',
  active: false,
  found: false,
  status: '',
};

/** Mapea un Vehicle de Prisma al reply gRPC (found=true). */
function toVehicleReply(v: Vehicle): VehicleReply {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    year: v.year,
    color: v.color,
    vehicleType: v.vehicleType,
    docStatus: v.docStatus,
    active: v.active,
    found: true,
    status: deriveVehicleReviewStatus(v),
  };
}

@Controller()
export class FleetGrpcController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /** Rechaza la RPC si la metadata no trae una identidad interna firmada (HMAC) válida. */
  private requireIdentity(metadata: Metadata): void {
    const identity = verifyGrpcIdentity(metadata, this.secret, { allowedAudiences: this.allowedAudiences });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
  }

  @GrpcMethod('FleetService', 'GetVehicle')
  async getVehicle({ id }: GetByIdRequest, metadata: Metadata): Promise<VehicleReply> {
    this.requireIdentity(metadata);
    const v = await this.prisma.read.vehicle.findUnique({ where: { id } });
    if (!v) return EMPTY_VEHICLE;
    return toVehicleReply(v);
  }

  /** Rehidratación: vehículos registrados por el conductor (id = driverId de identity). */
  @GrpcMethod('FleetService', 'GetDriverVehicles')
  async getDriverVehicles(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverVehiclesReply> {
    this.requireIdentity(metadata);
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { driverId: id, vehicles: vehicles.map(toVehicleReply) };
  }

  /**
   * Vehículo OPERADO del conductor — FUENTE ÚNICA del "vehículo que el conductor maneja". Resuelve con
   * `pickActiveVehicle` (selector AUTORITATIVO: selectedAt más reciente con docs vigentes), el MISMO que
   * usan el gate de ITV (getDriverInspectionStatus), el ping del driver-bff (`/drivers/vehicles/active`)
   * y el alta self-service. `id` = User.id (Vehicle.driverId). `found=false` si no tiene ninguno operable.
   * Dispatch lo consume al adjudicar para que el vehicleId del viaje NO diverja de lo que opera el conductor.
   */
  @GrpcMethod('FleetService', 'GetDriverActiveVehicle')
  async getDriverActiveVehicle(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<VehicleReply> {
    this.requireIdentity(metadata);
    const vehicles = await this.prisma.read.vehicle.findMany({ where: { driverId: id } });
    const active = pickActiveVehicle(vehicles);
    return active ? toVehicleReply(active) : EMPTY_VEHICLE;
  }

  @GrpcMethod('FleetService', 'GetDriverDocuments')
  async getDriverDocuments(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverDocumentsReply> {
    this.requireIdentity(metadata);
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: id },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { order: 'asc' } } },
    });
    return {
      driverId: id,
      documents: docs.map((d) => ({
        id: d.id,
        ownerType: d.ownerType,
        ownerId: d.ownerId,
        type: d.type,
        documentNumber: d.documentNumber,
        status: d.status,
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : '',
        // DEPRECADO: primera imagen (backward-compat). proto3 default "" si no hay archivo aún.
        fileS3Key: d.fileS3Key ?? '',
        // M5: motivo del rechazo que escribe el operador (proto3 default "" si no hay). El conductor lo ve.
        rejectionReason: d.rejectionReason ?? '',
        // Sub-lote 3A: las N imágenes (ordenadas). Admin las firma; el conductor recibe un subconjunto.
        images: d.images.map((img) => ({ s3Key: img.s3Key, side: img.side, order: img.order })),
      })),
    };
  }

  /**
   * Vigencia de la inspección técnica (ITV) del vehículo OPERADO del conductor — gate de aprobación.
   * `id` = User.id (Vehicle.driverId, NO el driverId de perfil). Regla: el vehículo OPERADO del conductor
   * (`pickActiveVehicle`: selector AUTORITATIVO ÚNICO — el MISMO que expone GetDriverActiveVehicle, que
   * dispatch consume al adjudicar, y que el driver-bff sella en el ping vía `/drivers/vehicles/active`)
   * debe tener una inspección VIGENTE (última `passed && nextDueAt > now`). Sin vehículo operable → no
   * vigente (NO_VEHICLE). Devuelve datos útiles (vehicleId, plate, nextDueAt, motivo) para un error claro
   * en admin-bff. Solo LEE (read replica).
   */
  @GrpcMethod('FleetService', 'GetDriverInspectionStatus')
  async getDriverInspectionStatus(
    { id }: GetByIdRequest,
    metadata: Metadata,
  ): Promise<DriverInspectionStatusReply> {
    this.requireIdentity(metadata);
    const now = new Date();
    const vehicles = await this.prisma.read.vehicle.findMany({ where: { driverId: id } });
    const active = pickActiveVehicle(vehicles);
    if (!active) {
      // Sin vehículo operable (ninguno registrado, o todos con docs vencidos): no puede operar.
      return {
        current: false,
        hasVehicle: false,
        vehicleId: '',
        plate: '',
        nextDueAt: '',
        passed: false,
        invalidReason: NO_VEHICLE_REASON,
      };
    }

    // Última inspección del vehículo operado (orderBy inspectedAt desc, take 1 = la VIGENTE candidata).
    const latest = await this.prisma.read.inspection.findFirst({
      where: { vehicleId: active.id },
      orderBy: { inspectedAt: 'desc' },
    });
    const current = isInspectionCurrent(latest, now);
    const reason = current ? null : (inspectionInvalidReason(latest, now) ?? InspectionInvalidReason.NONE);

    return {
      current,
      hasVehicle: true,
      vehicleId: active.id,
      plate: active.plate,
      nextDueAt: latest ? latest.nextDueAt.toISOString() : '',
      passed: latest?.passed ?? false,
      invalidReason: reason ?? '',
    };
  }
}
