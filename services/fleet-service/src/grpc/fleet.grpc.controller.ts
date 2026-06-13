/**
 * Controlador gRPC de fleet (paquete veo.fleet.v1.FleetService).
 * Lectura síncrona de vehículos y documentos para otros servicios (identity/admin).
 * Devuelve `found=false` en vez de lanzar, para que el llamante decida.
 */
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import { deriveVehicleReviewStatus } from '../vehicles/vehicle-rules';
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

interface FleetDocumentReply {
  id: string;
  ownerType: string;
  ownerId: string;
  type: string;
  documentNumber: string;
  status: string;
  expiresAt: string;
}

interface DriverDocumentsReply {
  driverId: string;
  documents: FleetDocumentReply[];
}

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
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /** Rechaza la RPC si la metadata no trae una identidad interna firmada (HMAC) válida. */
  private requireIdentity(metadata: Metadata): void {
    const identity = verifyGrpcIdentity(metadata, this.secret);
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
  async getDriverVehicles({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverVehiclesReply> {
    this.requireIdentity(metadata);
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { driverId: id, vehicles: vehicles.map(toVehicleReply) };
  }

  @GrpcMethod('FleetService', 'GetDriverDocuments')
  async getDriverDocuments({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverDocumentsReply> {
    this.requireIdentity(metadata);
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: id },
      orderBy: { createdAt: 'desc' },
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
      })),
    };
  }
}
