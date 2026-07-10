/**
 * Puerto + adaptador Prisma del `IdentityGrpcController` (FOUNDATION §10: ningún controller/service toca
 * `this.prisma` directo). El gRPC es un LECTOR cross-feature (proyecciones síncronas de identidad: User +
 * Driver + sus holds de suspensión, para public/admin/driver/dispatch): en vez de repartir sus consultas
 * por los repos de cada feature (users/, drivers/, que sirven a sus services), tiene su propio repo de
 * lectura — mismo criterio que el repo propio del gRPC de fleet. Es READ-ONLY: sin `runInTx`.
 *
 * TODAS las lecturas leen de la RÉPLICA (`prisma.read`): son proyecciones de display/enriquecimiento sin
 * gate de dinero (a diferencia del gRPC de fleet, que sí distingue `fresh`). La minimización de PII por
 * riel (descifrar o no el DNI, gatear la biometría) NO vive acá: es política de dominio del controller
 * (`toDriverReply`), que decide con el `aud` firmado del caller. El repo solo trae las FILAS.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, BackgroundCheckStatus, type User } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const IDENTITY_GRPC_REPO = Symbol('IDENTITY_GRPC_REPO');

/** Include del detalle de conductor: user (name/kyc/phone) + holds vigentes (solo `cause`). */
const DRIVER_DETAIL_INCLUDE = {
  user: { select: { name: true, kycStatus: true, phone: true } },
  suspensionHolds: { select: { cause: true } },
} satisfies Prisma.DriverInclude;

/** Include del conductor por userId: user (name/kyc/phone), SIN holds (el driver-rail no los consume). */
const DRIVER_WITH_USER_INCLUDE = {
  user: { select: { name: true, kycStatus: true, phone: true } },
} satisfies Prisma.DriverInclude;

/** Fila de conductor con user + holds vigentes (GetDriver single / GetDriversByIds batch). */
export type GrpcDriverDetail = Prisma.DriverGetPayload<{ include: typeof DRIVER_DETAIL_INCLUDE }>;

/** Fila de conductor con user (GetDriverByUser · driver-rail). */
export type GrpcDriverWithUser = Prisma.DriverGetPayload<{ include: typeof DRIVER_WITH_USER_INCLUDE }>;

/** Conteo de conductores por estado de antecedentes (stat cards del admin). */
export type GrpcDriverStatusCount = { backgroundCheckStatus: BackgroundCheckStatus; count: number };

/** Puerto: el IdentityGrpcController depende de esto, NO de Prisma. */
export interface IdentityGrpcRepository {
  /** Usuario por id (read réplica). `null` si no existe. */
  findUserById(id: string): Promise<User | null>;
  /** Batch de usuarios por id (read réplica) — anti-N+1 de la lista de vehículos. */
  findUsersByIds(ids: string[]): Promise<User[]>;

  /** Conductor por id con user + holds vigentes (read réplica) — detalle admin/public/dispatch. `null` si no existe. */
  findDriverById(id: string): Promise<GrpcDriverDetail | null>;
  /** Conductor por userId con user (read réplica) — driver-bff resuelve su propio perfil. `null` si no existe. */
  findDriverByUserId(userId: string): Promise<GrpcDriverWithUser | null>;
  /** Batch de conductores por id con user + holds (read réplica, UNA query IN(...)) — anti-N+1 de la lista admin. */
  findDriversByIds(ids: string[]): Promise<GrpcDriverDetail[]>;

  /** Conteo de conductores por backgroundCheckStatus (groupBy agregado en la réplica). */
  countDriversByBackgroundStatus(): Promise<GrpcDriverStatusCount[]>;
}

@Injectable()
export class PrismaIdentityGrpcRepository implements IdentityGrpcRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUserById(id: string): Promise<User | null> {
    return this.prisma.read.user.findUnique({ where: { id } });
  }

  findUsersByIds(ids: string[]): Promise<User[]> {
    return this.prisma.read.user.findMany({ where: { id: { in: ids } } });
  }

  findDriverById(id: string): Promise<GrpcDriverDetail | null> {
    return this.prisma.read.driver.findUnique({
      where: { id },
      include: DRIVER_DETAIL_INCLUDE,
    });
  }

  findDriverByUserId(userId: string): Promise<GrpcDriverWithUser | null> {
    return this.prisma.read.driver.findUnique({
      where: { userId },
      include: DRIVER_WITH_USER_INCLUDE,
    });
  }

  findDriversByIds(ids: string[]): Promise<GrpcDriverDetail[]> {
    return this.prisma.read.driver.findMany({
      where: { id: { in: ids } },
      include: DRIVER_DETAIL_INCLUDE,
    });
  }

  async countDriversByBackgroundStatus(): Promise<GrpcDriverStatusCount[]> {
    const groups = await this.prisma.read.driver.groupBy({
      by: ['backgroundCheckStatus'],
      _count: { _all: true },
    });
    return groups.map((g) => ({ backgroundCheckStatus: g.backgroundCheckStatus, count: g._count._all }));
  }
}
