/**
 * EmailAuthRepository — ÚNICO punto de acceso Prisma del método correo+contraseña (AuthMethod EMAIL_PASSWORD,
 * schema 'identity'). Espeja el mold de payment/rating: read/write split, OUTBOX-EN-TRANSACCIÓN y métodos con
 * NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo al service.
 *
 * SEAM con EmailAuthService: la LÓGICA DE DOMINIO (argon2id, anti-enumeración, lockout, verificación de correo,
 * account-linking, reset con revocación de sesiones) vive ENTERA en el service. Este repo solo hace acceso a
 * datos y CRISTALIZA el filtro por `type: EMAIL_PASSWORD` (el método SIEMPRE es EMAIL_PASSWORD acá → el WHERE
 * del `type_email` compuesto lo hardcodea el repo; el caller solo aporta el email). Los helpers de dominio
 * transaccionales (`resolveUserForVerifiedEmail`/`registerUser`) reciben el `tx` OPACO forwardeado por el
 * service — no lo dereferencia. La marca de verificado y su evento `user.email_verified` van en la MISMA tx.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type AuthMethod } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type EmailAuthTx = Prisma.TransactionClient;

/** AuthMethod con su User embebido (login / verify-email necesitan los claims del usuario). */
export type AuthMethodWithUser = Prisma.AuthMethodGetPayload<{ include: { user: true } }>;

/** Filtro del método EMAIL_PASSWORD por email (fuente única del WHERE compuesto). */
function emailPasswordKey(email: string): Prisma.AuthMethodTypeEmailCompoundUniqueInput {
  return { type: 'EMAIL_PASSWORD', email };
}

@Injectable()
export class EmailAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica salvo las marcadas primary) ─────────────────────────────────────────────────────

  /** Método EMAIL_PASSWORD por email (register/resend/forgot). Réplica. */
  findEmailAuthMethod(email: string): Promise<AuthMethod | null> {
    return this.prisma.read.authMethod.findUnique({
      where: { type_email: emailPasswordKey(email) },
    });
  }

  /** Método EMAIL_PASSWORD + su User (login). Réplica. */
  findEmailAuthMethodWithUser(email: string): Promise<AuthMethodWithUser | null> {
    return this.prisma.read.authMethod.findUnique({
      where: { type_email: emailPasswordKey(email) },
      include: { user: true },
    });
  }

  /** Método EMAIL_PASSWORD + su User, de la PRIMARIA (verify-email: sin lag tras el código). */
  findEmailAuthMethodWithUserOnPrimary(email: string): Promise<AuthMethodWithUser | null> {
    return this.prisma.write.authMethod.findUnique({
      where: { type_email: emailPasswordKey(email) },
      include: { user: true },
    });
  }

  /** Método EMAIL_PASSWORD de la PRIMARIA (reset-password: sin lag tras el código). */
  findEmailAuthMethodOnPrimary(email: string): Promise<AuthMethod | null> {
    return this.prisma.write.authMethod.findUnique({
      where: { type_email: emailPasswordKey(email) },
    });
  }

  // ── Escrituras no transaccionales (primary) ───────────────────────────────────────────────────────────

  /** Reescribe el hash argon2id de la contraseña (reset). El service ya hasheó. */
  async updateAuthMethodPassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.write.authMethod.update({ where: { id }, data: { passwordHash } });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service ORQUESTA el re-chequeo anti-carrera, el account-linking y el
   * alta transaccional (helpers que reciben el `tx` opaco), o la marca de verificado + su evento.
   */
  runInTransaction<T>(work: (tx: EmailAuthTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: EmailAuthTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /** Re-chequeo anti-carrera del método EMAIL_PASSWORD, DENTRO de la tx. */
  findEmailAuthMethodTx(tx: EmailAuthTx, email: string): Promise<AuthMethod | null> {
    return tx.authMethod.findUnique({ where: { type_email: emailPasswordKey(email) } });
  }

  /** Cuelga la credencial EMAIL_PASSWORD de un User existente (account-linking), DENTRO de la tx. */
  async createEmailAuthMethodTx(
    tx: EmailAuthTx,
    data: Prisma.AuthMethodUncheckedCreateInput,
  ): Promise<void> {
    await tx.authMethod.create({ data });
  }

  /**
   * Marca el correo verificado (emailVerified + verified HARDCODEADOS), DENTRO de la tx. Atómico con el evento
   * user.email_verified que emite el service.
   */
  async markEmailVerifiedTx(tx: EmailAuthTx, id: string): Promise<void> {
    await tx.authMethod.update({
      where: { id },
      data: { emailVerified: true, verified: true },
    });
  }
}
