/**
 * ReferralsRepository — ÚNICO punto de acceso Prisma del programa de referidos (schema 'identity'). Espeja el
 * mold de payment/rating: read/write split, OUTBOX-EN-TRANSACCIÓN y métodos con NOMBRES DE DOMINIO — nunca
 * filtra `PrismaClient` crudo al service.
 *
 * SEAM con ReferralsService: la LÓGICA DE DOMINIO (generación perezosa del código, no-auto-referirse, un
 * referido UNA sola vez, IDEMPOTENCIA de la recompensa) vive ENTERA en el service. Este repo solo hace acceso
 * a datos y CRISTALIZA el CAS de reclamo del reward (`status=PENDING` HARDCODEADO en el WHERE → solo el primer
 * `trip.completed` gana el reward; un re-run ve count 0). El abono del crédito y su evento `referral.rewarded`
 * van en la MISMA tx (outbox-en-transacción · FOUNDATION §6).
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Referral } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type ReferralTx = Prisma.TransactionClient;

@Injectable()
export class ReferralsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ────────────────────────────────────────────────────────────────────────────────

  /** Cuántos referidos tiene el usuario (para el resumen). Réplica. */
  countReferralsByReferrer(referrerUserId: string): Promise<number> {
    return this.prisma.read.referral.count({ where: { referrerUserId } });
  }

  /** Créditos de referido acumulados del usuario. Réplica. */
  findUserRewardCents(userId: string): Promise<{ referralRewardCents: number } | null> {
    return this.prisma.read.user.findUnique({
      where: { id: userId },
      select: { referralRewardCents: true },
    });
  }

  /** Estado del código de referido del usuario + tombstone (generación perezosa). Réplica. */
  findUserReferralCodeState(
    userId: string,
  ): Promise<{ referralCode: string | null; deletedAt: Date | null } | null> {
    return this.prisma.read.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, deletedAt: true },
    });
  }

  /** Solo el código del usuario (resolución de la carrera del UNIQUE en tryAssignCode). Réplica. */
  findUserReferralCode(userId: string): Promise<{ referralCode: string | null } | null> {
    return this.prisma.read.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
  }

  /** El referidor DUEÑO de un código (canje). Réplica. */
  findReferrerByCode(code: string): Promise<{ id: string; deletedAt: Date | null } | null> {
    return this.prisma.read.user.findUnique({
      where: { referralCode: code },
      select: { id: true, deletedAt: true },
    });
  }

  /** El vínculo de referido de un usuario (un usuario se refiere UNA vez · idempotencia del reward). Réplica. */
  findReferralByReferred(referredUserId: string): Promise<Referral | null> {
    return this.prisma.read.referral.findUnique({ where: { referredUserId } });
  }

  // ── Escrituras no transaccionales (primary) ───────────────────────────────────────────────────────────

  /**
   * Fija el `referralCode` único al usuario (un intento). Puede lanzar la violación del UNIQUE que el service
   * capta (`isUniqueViolation`) para reintentar. El `select` mínimo se conserva del original.
   */
  async assignReferralCode(userId: string, code: string): Promise<void> {
    await this.prisma.write.user.update({
      where: { id: userId },
      data: { referralCode: code },
      select: { id: true },
    });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA el CAS idempotente + el abono + el evento. */
  runInTransaction<T>(work: (tx: ReferralTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: ReferralTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /** Crea el vínculo referidor↔referido, DENTRO de la tx. El service arma la data (status PENDING). */
  async createReferral(tx: ReferralTx, data: Prisma.ReferralUncheckedCreateInput): Promise<void> {
    await tx.referral.create({ data });
  }

  /**
   * CAS de reclamo idempotente del reward: `status=PENDING` HARDCODEADO en el WHERE → PENDING → REWARDED
   * (+ rewardCents + rewardedAt). Solo el primer `trip.completed` que encuentre PENDING gana (count 1); un
   * re-run/otra corrida ve count 0. El service aporta el monto computado.
   */
  casClaimReferralReward(
    tx: ReferralTx,
    referralId: string,
    rewardCents: number,
  ): Promise<{ count: number }> {
    return tx.referral.updateMany({
      where: { id: referralId, status: 'PENDING' },
      data: { status: 'REWARDED', rewardCents, rewardedAt: new Date() },
    });
  }

  /** Abona el crédito de referido al referidor (increment atómico), DENTRO de la tx del reclamo. */
  async incrementUserReward(
    tx: ReferralTx,
    referrerUserId: string,
    rewardCents: number,
  ): Promise<void> {
    await tx.user.update({
      where: { id: referrerUserId },
      data: { referralRewardCents: { increment: rewardCents } },
    });
  }
}
