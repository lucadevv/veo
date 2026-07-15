/**
 * PhoneLinkRepository — ÚNICO punto de acceso Prisma del vínculo teléfono↔perfil (ADR-012 phone-link, schema
 * 'identity'). Espeja el mold de payment/rating: read/write split y métodos con NOMBRES DE DOMINIO — nunca
 * filtra `PrismaClient` crudo al service.
 *
 * SEAM con PhoneLinkService: la LÓGICA DE DOMINIO (PHONE_TAKEN anti-enumeración, reuso de la infra OTP,
 * reemplazo idempotente del teléfono, audit de PII enmascarada) vive ENTERA en el service. El set del teléfono
 * y el upsert idempotente del AuthMethod PHONE_OTP (con `update: { verified: true }` HARDCODEADO) van en la
 * MISMA tx.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type User } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PhoneLinkTx = Prisma.TransactionClient;

@Injectable()
export class PhoneLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Dueño de un teléfono (@unique) — gate PHONE_TAKEN. Réplica. */
  findUserByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.read.user.findUnique({ where: { phone }, select: { id: true } });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA el re-chequeo anti-carrera + el set + el upsert. */
  runInTransaction<T>(work: (tx: PhoneLinkTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Dueño del teléfono DENTRO de la tx (re-chequeo anti-carrera del PHONE_TAKEN). */
  findUserByPhoneTx(tx: PhoneLinkTx, phone: string): Promise<{ id: string } | null> {
    return tx.user.findUnique({ where: { phone }, select: { id: true } });
  }

  /** Setea (o reemplaza) el teléfono del usuario, DENTRO de la tx. */
  async setUserPhoneTx(tx: PhoneLinkTx, userId: string, phone: string): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { phone } });
  }

  /**
   * Upsert idempotente del AuthMethod PHONE_OTP (`type` + create + `update: { verified: true }` HARDCODEADOS),
   * DENTRO de la tx. El número NO vive acá (vive en User.phone) → reemplazar el teléfono conserva la fila.
   */
  async upsertPhoneOtpAuthMethodTx(tx: PhoneLinkTx, userId: string): Promise<void> {
    await tx.authMethod.upsert({
      where: { userId_type: { userId, type: 'PHONE_OTP' } },
      create: { userId, type: 'PHONE_OTP', verified: true },
      update: { verified: true },
    });
  }
}
