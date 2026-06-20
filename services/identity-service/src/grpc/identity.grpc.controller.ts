/**
 * Controlador gRPC de identity (paquete veo.identity.v1.IdentityService).
 * Lectura síncrona de identidad para otros servicios. Devuelve `found=false` en vez de lanzar,
 * para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { DniFaceMatchStatus } from '@veo/shared-types';
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
  /** BE-1b · nombre visible del conductor: legal_name del onboarding (lo que escribe la app), fallback User.name. "" si no registrado. */
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
  /** DNI del conductor (documento de identidad · Compliance+); "" si no registrado. */
  documentId: string;
  /** Fecha de nacimiento del conductor en `yyyy-mm-dd`; "" si no registrada. */
  birthDate: string;
  /** Sub-lote 3C · estado del binding DNI↔selfie (NOT_RUN/MATCHED/NO_MATCH). */
  dniFaceMatchStatus: string;
  /** Score del face-match en 0..100; 0 si no se corrió. */
  dniFaceMatchScore: number;
  /** ISO-8601 de cuándo se corrió el face-match; "" si no se corrió. */
  dniFaceMatchedAt: string;
}

/** Request batch de GetDriversByIds (lectura para listados del admin). */
interface DriverIdsRequest {
  ids: string[];
}

/** Reply batch de GetDriversByIds. Orden libre; el consumidor mapea por id. */
interface DriversByIdsReply {
  drivers: DriverReply[];
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
  documentId: '',
  birthDate: '',
  dniFaceMatchStatus: DniFaceMatchStatus.NOT_RUN,
  dniFaceMatchScore: 0,
  dniFaceMatchedAt: '',
};

@Controller()
export class IdentityGrpcController {
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
    // BE-1b — `include: user` trae los scalars del Driver (incluido legalName) + el nombre/kyc/phone
    // del usuario (driver→user, ambos en identity: NO es join cross-servicio).
    const d = await this.prisma.read.driver.findUnique({
      where: { id },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  @GrpcMethod('IdentityService', 'GetDriverByUser')
  async getDriverByUser({ id }: GetByIdRequest, metadata: Metadata): Promise<DriverReply> {
    this.requireIdentity(metadata);
    // `include: user` trae los scalars del Driver (incluido legalName) + nombre/kyc/phone del usuario.
    const d = await this.prisma.read.driver.findUnique({
      where: { userId: id },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return d ? this.toDriverReply(d) : EMPTY_DRIVER;
  }

  /**
   * Lectura BATCH para enriquecer listados del admin (nombre/teléfono por página, sin N+1): UNA query
   * `findMany WHERE id IN (...)`. El admin-bff la llama una vez por página con los driverId visibles.
   * Devuelve solo los hallados (orden libre — el consumidor mapea por id); ids vacíos → []. Idempotente.
   */
  @GrpcMethod('IdentityService', 'GetDriversByIds')
  async getDriversByIds(
    { ids }: DriverIdsRequest,
    metadata: Metadata,
  ): Promise<DriversByIdsReply> {
    this.requireIdentity(metadata);
    if (!ids || ids.length === 0) return { drivers: [] };
    const drivers = await this.prisma.read.driver.findMany({
      where: { id: { in: ids } },
      include: { user: { select: { name: true, kycStatus: true, phone: true } } },
    });
    return { drivers: drivers.map((d) => this.toDriverReply(d)) };
  }

  private toDriverReply(d: {
    id: string;
    userId: string;
    currentStatus: string;
    backgroundCheckStatus: string;
    averageRating: { toString(): string };
    suspendedAt: Date | null;
    legalName: string | null;
    rejectionReason: string | null;
    licenseNumber: string | null;
    documentId: string | null;
    birthDate: Date | null;
    createdAt: Date;
    faceEnrolledAt: Date | null;
    lastVerifiedAt: Date | null;
    dniFaceMatched: boolean | null;
    dniFaceMatchScore: number | null;
    dniFaceMatchedAt: Date | null;
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
      // BE-1b — nombre del conductor para el admin: PREFERIR legal_name del onboarding (lo que la app
      // escribe en `identity.drivers.legal_name`), fallback User.name. "" si ninguno está registrado.
      name: d.legalName || d.user?.name || '',
      // Motivo del último rechazo (dead-end fix); "" si no está rechazado o no se dio motivo.
      rejectionReason: d.rejectionReason ?? '',
      // Campos de revisión del operador (admin-bff GET /ops/drivers/:id). "" cuando no hay dato.
      licenseNumber: d.licenseNumber ?? '',
      kycStatus: d.user?.kycStatus ?? '',
      createdAt: d.createdAt.toISOString(),
      faceEnrolledAt: d.faceEnrolledAt ? d.faceEnrolledAt.toISOString() : '',
      lastVerifiedAt: d.lastVerifiedAt ? d.lastVerifiedAt.toISOString() : '',
      phone: d.user?.phone ?? '',
      // DNI + fecha de nacimiento para la revisión del operador (admin valida informado). birthDate es
      // @db.Date → yyyy-mm-dd; "" cuando no hay dato (proto3 default, nunca null).
      documentId: d.documentId ?? '',
      birthDate: d.birthDate ? d.birthDate.toISOString().slice(0, 10) : '',
      // Sub-lote 3C · binding DNI↔selfie GUARDADO. El estado se DERIVA del veredicto persistido (null = aún
      // no se corrió → NOT_RUN; true → MATCHED; false → NO_MATCH): estado tipado explícito, sin la
      // ambigüedad del bool. Score 0 / fecha "" cuando no se corrió (proto3 default honesto).
      dniFaceMatchStatus:
        d.dniFaceMatched === null || d.dniFaceMatched === undefined
          ? DniFaceMatchStatus.NOT_RUN
          : d.dniFaceMatched
            ? DniFaceMatchStatus.MATCHED
            : DniFaceMatchStatus.NO_MATCH,
      dniFaceMatchScore: d.dniFaceMatchScore ?? 0,
      dniFaceMatchedAt: d.dniFaceMatchedAt ? d.dniFaceMatchedAt.toISOString() : '',
    };
  }
}
