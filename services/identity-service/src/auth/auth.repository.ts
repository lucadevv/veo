/**
 * AuthRepository — ÚNICO punto de acceso Prisma del login teléfono+OTP y del refresh (schema 'identity').
 * Espeja el mold de payment/rating: read/write split y métodos con NOMBRES DE DOMINIO — nunca filtra
 * `PrismaClient` crudo al service.
 *
 * SEAM con AuthService: la LÓGICA DE DOMINIO (gate de tipo de cuenta, single-session del conductor, rotación
 * de refresh con repoblado de autorización, resolución admin/user por `typ`) vive ENTERA en el service. Este
 * repo solo hace acceso a datos. El alta transaccional (`registerUser`) recibe el `tx` OPACO forwardeado por
 * el service — no lo dereferencia. El upsert idempotente del AuthMethod PHONE_OTP lleva `update: {}` hardcodeado.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type AdminUser, type User } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type AuthTx = Prisma.TransactionClient;

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ────────────────────────────────────────────────────────────────────────────────

  /** Usuario por id (repoblado de autorización en el refresh passenger/driver + fallback). Réplica. */
  findUserById(id: string): Promise<User | null> {
    return this.prisma.read.user.findUnique({ where: { id } });
  }

  /** Operador por id (repoblado de roles+email en el refresh admin). Réplica. */
  findAdminById(id: string): Promise<AdminUser | null> {
    return this.prisma.read.adminUser.findUnique({ where: { id } });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA re-login idempotente vs alta nueva. */
  runInTransaction<T>(work: (tx: AuthTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Usuario por teléfono (@unique), DENTRO de la tx del login. */
  findUserByPhoneTx(tx: AuthTx, phone: string): Promise<User | null> {
    return tx.user.findUnique({ where: { phone } });
  }

  /**
   * Asegura el AuthMethod PHONE_OTP del usuario (idempotente, ADR-012 Lote 1), DENTRO de la tx. `type` PHONE_OTP,
   * el `create` verificado y el `update: {}` van HARDCODEADOS (re-entrega no muta la credencial existente).
   */
  async ensurePhoneOtpAuthMethodTx(tx: AuthTx, userId: string): Promise<void> {
    await tx.authMethod.upsert({
      where: { userId_type: { userId, type: 'PHONE_OTP' } },
      create: { userId, type: 'PHONE_OTP', verified: true },
      update: {},
    });
  }
}
