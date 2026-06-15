/**
 * CreditService — saldo de crédito GASTABLE del usuario (Ola 2A · redención de referidos · Lote A).
 *
 * payment-service es dueño del saldo (microservicios: identity guarda "ganado de por vida" en
 * `User.referralRewardCents`; payment guarda lo "gastable" acá). Este service solo ACREDITA por el evento
 * `referral.rewarded`; el GASTO en el cobro llega en el Lote B (decremento en la MISMA tx ACID del cobro,
 * sin doble-gasto cross-service).
 *
 * Idempotencia financiera (§3 CLAUDE): el ledger `UserCreditEntry.sourceRef` es UNIQUE = el `eventId` del
 * evento. Un `referral.rewarded` re-entregado (mismo eventId) viola el UNIQUE → la tx aborta → NO re-acredita.
 */
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { PrismaService } from '../infra/prisma.service';
import { CreditSource } from '../generated/prisma';

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Acredita `rewardCents` al saldo gastable de `userId` por un referido. IDEMPOTENTE por `eventId`.
   * Devuelve `true` si acreditó, `false` si el evento ya estaba aplicado (re-entrega) o no hay nada que sumar.
   */
  async creditFromReferral(input: { userId: string; rewardCents: number; eventId: string }): Promise<boolean> {
    const { userId, rewardCents, eventId } = input;
    // Defensivo: el schema garantiza rewardCents int, pero un 0/negativo no es una acreditación.
    if (rewardCents <= 0) return false;

    try {
      await this.prisma.write.$transaction(async (tx) => {
        // 1) Asegura el registro de saldo (no-op si ya existe) para que el FK del movimiento se satisfaga.
        await tx.userCredit.upsert({
          where: { userId },
          create: { userId, balanceCents: 0 },
          update: {},
        });
        // 2) GUARD de idempotencia ANTES del increment: el INSERT viola UNIQUE(source_ref) si el evento ya
        //    se procesó → P2002 → la tx ENTERA aborta (el increment de abajo NO ocurre).
        await tx.userCreditEntry.create({
          data: {
            id: uuidv7(),
            userId,
            deltaCents: rewardCents,
            source: CreditSource.REFERRAL,
            sourceRef: eventId,
          },
        });
        // 3) Solo si el movimiento era nuevo: aplica el saldo.
        await tx.userCredit.update({
          where: { userId },
          data: { balanceCents: { increment: rewardCents } },
        });
      });
      this.logger.log(`Crédito de referido acreditado: user=${userId} +${rewardCents}c (event=${eventId})`);
      return true;
    } catch (err) {
      if (isUniqueViolation(err, 'sourceRef')) {
        this.logger.debug(`referral.rewarded ${eventId} ya acreditado (idempotente); skip`);
        return false;
      }
      throw err; // transitorio → el consumer relanza y Kafka reintenta; sigue siendo idempotente.
    }
  }
}
