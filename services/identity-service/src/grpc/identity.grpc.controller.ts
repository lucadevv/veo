/**
 * Controlador gRPC de identity (paquete veo.identity.v1.IdentityService).
 * Lectura síncrona de identidad para otros servicios. Devuelve `found=false` en vez de lanzar,
 * para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

interface GetByIdRequest {
  id: string;
}
interface UserReply {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
  name: string;
}
interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
  /** ISO-8601 de la suspensión del conductor; "" si NO está suspendido (gate de elegibilidad PUJA). */
  suspendedAt: string;
  /** BE-1b · nombre visible del conductor (de User.name vía la relación driver→user). "" si no registrado. */
  name: string;
  /** Motivo del último rechazo de antecedentes; "" si NO está rechazado o no se dio motivo. */
  rejectionReason: string;
  /** Licencia/DNI del conductor (Compliance+ · revisión del operador); "" si no registrada. */
  licenseNumber: string;
  /** Estado KYC del usuario asociado (driver→user); "" si no incluido. */
  kycStatus: string;
  /** ISO-8601 de alta del conductor; "" si no disponible. */
  createdAt: string;
  /** ISO-8601 del enrolamiento biométrico facial; "" si aún no enroló. */
  faceEnrolledAt: string;
  /** ISO-8601 de la última verificación biométrica en vivo; "" si nunca verificó. */
  lastVerifiedAt: string;
  /** Teléfono del usuario asociado (driver→user); "" si no registrado. */
  phone: string;
}

const EMPTY_DRIVER: DriverReply = {
  id: '',
  userId: '',
  currentStatus: '',
  backgroundCheckStatus: '',
  averageRating: 0,
  found: false,
  suspendedAt: '',
  name: '',
  rejectionReason: '',
  licenseNumber: '',
  kycStatus: '',
  createdAt: '',
  faceEnrolledAt: '',
  lastVerifiedAt: '',
  phone: '',
};

@Controller()
export class IdentityGrpcController {
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

  @GrpcMethod('IdentityService', 'GetUser')
  async getUser({ id }: GetByIdRequest, metadata: Metadata): Promise<UserReply> {
    this.requireIdentity(metadata);
    const u = await this.prisma.read.user.findUnique({ where: { id } });
    if (!u) {
      return { id: '', phone: '', type: '', kycStatus: '', deleted: false, found: false, name: '' };
    }
    return {
      id: u.id,
      phone: u.phone ?? '',
      type: u.type,
      kycStatus: u.kycStatus,
      deleted: u.deletedAt !== null,
      found: true,
      name: u.name ?? '',
    };
  }

  @GrpcMethod('IdentityService', 'GetDriver')
  async getDriver({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverReply> {
    this.requireIdentity(metadata);
    // BE-1b — incluye el nombre del usuario (driver→user, ambos en identity: NO es join cross-servicio).
    const d = await this.prisma.read.driver.findUnique({
      where: { id },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  @GrpcMethod('IdentityService', 'GetDriverByUser')
  async getDriverByUser({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverReply> {
    this.requireIdentity(metadata);
    const d = await this.prisma.read.driver.findUnique({
      where: { userId: id },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  private toDriverReply(d: {
    id: string;
    userId: string;
    currentStatus: string;
    backgroundCheckStatus: string;
    averageRating: { toString(): string };
    suspendedAt: Date | null;
    rejectionReason: string | null;
    licenseNumber: string | null;
    createdAt: Date;
    faceEnrolledAt: Date | null;
    lastVerifiedAt: Date | null;
    user?: { name: string | null; kycStatus?: string | null; phone?: string | null } | null;
  }): DriverReply {
    return {
      id: d.id,
      userId: d.userId,
      currentStatus: d.currentStatus,
      backgroundCheckStatus: d.backgroundCheckStatus,
      averageRating: Number(d.averageRating.toString()),
      found: true,
      suspendedAt: d.suspendedAt ? d.suspendedAt.toISOString() : '',
      // BE-1b — nombre del usuario asociado (driver→user). "" si no se incluyó / no registrado.
      name: d.user?.name ?? '',
      // Motivo del último rechazo (dead-end fix); "" si no está rechazado o no se dio motivo.
      rejectionReason: d.rejectionReason ?? '',
      // Campos de revisión del operador (admin-bff GET /ops/drivers/:id). "" cuando no hay dato.
      licenseNumber: d.licenseNumber ?? '',
      kycStatus: d.user?.kycStatus ?? '',
      createdAt: d.createdAt.toISOString(),
      faceEnrolledAt: d.faceEnrolledAt ? d.faceEnrolledAt.toISOString() : '',
      lastVerifiedAt: d.lastVerifiedAt ? d.lastVerifiedAt.toISOString() : '',
      phone: d.user?.phone ?? '',
    };
  }
}
