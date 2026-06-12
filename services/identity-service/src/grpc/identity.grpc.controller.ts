/**
 * Controlador gRPC de identity (paquete veo.identity.v1.IdentityService).
 * Lectura síncrona de identidad para otros servicios. Devuelve `found=false` en vez de lanzar,
 * para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../infra/prisma.service';

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
};

@Controller()
export class IdentityGrpcController {
  constructor(private readonly prisma: PrismaService) {}

  @GrpcMethod('IdentityService', 'GetUser')
  async getUser({ id }: GetByIdRequest): Promise<UserReply> {
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
  async getDriver({ id }: GetByIdRequest): Promise<DriverReply> {
    // BE-1b — incluye el nombre del usuario (driver→user, ambos en identity: NO es join cross-servicio).
    const d = await this.prisma.read.driver.findUnique({
      where: { id },
      include: { user: { select: { name: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  @GrpcMethod('IdentityService', 'GetDriverByUser')
  async getDriverByUser({ id }: GetByIdRequest): Promise<DriverReply> {
    const d = await this.prisma.read.driver.findUnique({
      where: { userId: id },
      include: { user: { select: { name: true } } },
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
    user?: { name: string | null } | null;
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
    };
  }
}
