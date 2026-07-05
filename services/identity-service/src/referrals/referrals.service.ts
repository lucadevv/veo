/**
 * ReferralsService — programa de referidos (Ola 2A).
 *
 * Modelo HONESTO y simple:
 *  - Cada usuario tiene un `referralCode` único, generado PEREZOSAMENTE la 1ª vez que lo consulta.
 *  - `applyReferral(newUserId, code)` vincula referidor↔referido UNA sola vez (no auto-referirse),
 *    y emite `user.referred`.
 *  - La recompensa se otorga al cumplir la condición (el 1er viaje del referido). En vez de generar
 *    un cupón en otro servicio (acoplamiento), la recompensa se modela como un CRÉDITO en céntimos
 *    sobre el referidor (`User.referralRewardCents`), otorgado por un consumidor de `trip.completed`.
 *    Al otorgarse se emite `referral.rewarded` (otros servicios podrían consumirla para abonar).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox, isUniqueViolation } from '@veo/database';
import { ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';
import { generateReferralCode, normalizeReferralCode } from './referral-code';

/**
 * Tope de reintentos ante colisión del UNIQUE del `referralCode`. La colisión es de probabilidad ínfima
 * (código aleatorio); 5 es cinturón-y-tirantes. Agotarlo lanza ConflictError (no se cuelga).
 */
const MAX_CODE_ATTEMPTS = 5;

export interface ReferralSummary {
  code: string;
  referredCount: number;
  rewardsEarnedCents: number;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  private readonly rewardCents: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.rewardCents = config.getOrThrow<number>('REFERRAL_REWARD_CENTS');
  }

  /** Resumen para `GET /referrals/me`: código (generado perezosamente), referidos y créditos. */
  async summary(userId: string): Promise<ReferralSummary> {
    const code = await this.ensureCode(userId);
    const [referredCount, user] = await Promise.all([
      this.prisma.read.referral.count({ where: { referrerUserId: userId } }),
      this.prisma.read.user.findUnique({
        where: { id: userId },
        select: { referralRewardCents: true },
      }),
    ]);
    return {
      code,
      referredCount,
      rewardsEarnedCents: user?.referralRewardCents ?? 0,
    };
  }

  /** Devuelve el referralCode del usuario, generándolo (único) si aún no tiene uno. */
  async ensureCode(userId: string): Promise<string> {
    const user = await this.prisma.read.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    if (user.referralCode) return user.referralCode;

    // Reintenta ante colisión del UNIQUE (probabilidad baja). Cada vuelta es UNA llamada al helper — no una
    // query suelta dentro del for (no es n+1: retry ACOTADO de una operación, no iteración de colección).
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = await this.tryAssignCode(userId);
      if (code) return code;
    }
    throw new ConflictError('No se pudo generar un código de referido único');
  }

  /**
   * UN intento de fijar un `referralCode` único al usuario. Devuelve el código fijado (o el que otro
   * proceso fijó en una carrera), o `null` si hubo colisión del UNIQUE sin código a la vista (→ reintentar).
   * Aislado del `for` de `ensureCode` para que las queries no queden dentro de un loop (no es n+1).
   */
  private async tryAssignCode(userId: string): Promise<string | null> {
    const candidate = generateReferralCode();
    try {
      await this.prisma.write.user.update({
        where: { id: userId },
        data: { referralCode: candidate },
        select: { id: true },
      });
      return candidate;
    } catch (err) {
      if (isUniqueViolation(err, 'referralCode')) {
        // Colisión: si otro proceso lo fijó en paralelo, devolvemos ESE; si no, null → el caller reintenta.
        const fresh = await this.prisma.read.user.findUnique({
          where: { id: userId },
          select: { referralCode: true },
        });
        return fresh?.referralCode ?? null;
      }
      throw err;
    }
  }

  /**
   * Canjea un código de referido para un usuario nuevo (`POST /referrals/redeem`). Reglas:
   *  - El código debe existir (404 si no).
   *  - No auto-referirse (400).
   *  - Un usuario solo puede ser referido UNA vez (409 si ya lo fue).
   * Emite `user.referred`. La recompensa se otorga después, al 1er viaje del referido.
   */
  async applyReferral(newUserId: string, rawCode: string): Promise<ReferralSummary> {
    const code = normalizeReferralCode(rawCode);
    const referrer = await this.prisma.read.user.findUnique({
      where: { referralCode: code },
      select: { id: true, deletedAt: true },
    });
    if (!referrer || referrer.deletedAt)
      throw new NotFoundError('Código de referido inválido', { code });
    if (referrer.id === newUserId) {
      throw new ValidationError('No puedes usar tu propio código de referido');
    }

    const existing = await this.prisma.read.referral.findUnique({
      where: { referredUserId: newUserId },
    });
    if (existing) throw new ConflictError('Este usuario ya fue referido');

    try {
      await this.prisma.write.$transaction(async (tx) => {
        await tx.referral.create({
          data: {
            referrerUserId: referrer.id,
            referredUserId: newUserId,
            code,
            status: 'PENDING',
          },
        });
        await enqueueOutbox(
          tx,
          createEnvelope({
            eventType: 'user.referred',
            producer: 'identity-service',
            payload: {
              referrerUserId: referrer.id,
              referredUserId: newUserId,
              code,
              at: new Date().toISOString(),
            },
          }),
          referrer.id,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err, 'referredUserId')) {
        throw new ConflictError('Este usuario ya fue referido');
      }
      throw err;
    }

    return this.summary(newUserId);
  }

  /**
   * Otorga la recompensa al referidor por el 1er viaje del referido (idempotente): si el referido
   * tiene un vínculo PENDING, lo marca REWARDED, abona el crédito al referidor y emite
   * `referral.rewarded`. Si ya estaba REWARDED o no hay vínculo, no hace nada.
   * Lo invoca el consumidor de `trip.completed` con el passengerId del viaje.
   */
  async rewardReferralForTrip(referredUserId: string, tripId: string): Promise<void> {
    const referral = await this.prisma.read.referral.findUnique({
      where: { referredUserId },
    });
    if (!referral || referral.status === 'REWARDED') return;

    await this.prisma.write.$transaction(async (tx) => {
      // Reclamo idempotente: solo el primer trip.completed que encuentre PENDING gana el reward.
      const claimed = await tx.referral.updateMany({
        where: { id: referral.id, status: 'PENDING' },
        data: { status: 'REWARDED', rewardCents: this.rewardCents, rewardedAt: new Date() },
      });
      if (claimed.count === 0) return; // otro proceso ya lo otorgó

      await tx.user.update({
        where: { id: referral.referrerUserId },
        data: { referralRewardCents: { increment: this.rewardCents } },
      });

      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'referral.rewarded',
          producer: 'identity-service',
          payload: {
            referrerUserId: referral.referrerUserId,
            referredUserId,
            rewardCents: this.rewardCents,
            tripId,
            at: new Date().toISOString(),
          },
        }),
        referral.referrerUserId,
      );
    });
    this.logger.log(
      `Recompensa de referido otorgada a ${referral.referrerUserId} por viaje ${tripId}`,
    );
  }
}
