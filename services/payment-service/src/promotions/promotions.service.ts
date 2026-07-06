/**
 * PromotionsService — catálogo de promociones/cupones y su canje idempotente (Ola 2A).
 *
 * Decisión BR (comentada en el schema): el descuento de una promo reduce SOLO lo que paga el
 * pasajero sobre el bruto (`grossCents`). La comisión de plataforma se sigue calculando sobre el
 * bruto y la propina queda intacta — es la plataforma quien asume el costo de la promo. Por eso el
 * cobro (PaymentsService.charge) resta `discountCents` a `amountCents` pero no toca `commissionCents`.
 *
 * `validatePromo` es una previsualización pura (no muta). `redeemPromo` es idempotente por `dedupKey`
 * (UNIQUE) y por la tripleta (promotionId,userId,tripId): un único uso por usuario/regla/viaje.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox, isUniqueViolation } from '@veo/database';
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import type { Promotion } from '../generated/prisma';
import {
  evaluatePromo,
  normalizeCode,
  reasonMessage,
  type PromoInvalidReason,
} from './promotions.policy';

export interface PromoValidation {
  code: string;
  kind: 'PERCENTAGE' | 'FIXED';
  valid: boolean;
  discountCents: number;
  reason?: string;
}

export interface RedeemInput {
  code: string;
  userId: string;
  tripId: string;
  fareCents: number;
  dedupKey: string;
}

export interface RedeemResult {
  redemptionId: string;
  promotionId: string;
  code: string;
  discountCents: number;
}

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Usos de una promo, ACOTADOS (evita el count-scan sin techo de una promo popular en CADA validate/charge):
   *  - `userUses`: count por-usuario — índice `[promotionId, userId]`, acotado por las redenciones de UN usuario.
   *  - `totalUses`: el gate solo lo compara `>= maxTotalUses` (cuando maxTotalUses>0). Si es ilimitado (0), NO hay
   *    tope → no contamos (0). Si >0, acotamos el scan a `maxTotalUses` filas con `findMany take`: basta saber si
   *    el tope se alcanzó — no escanear el historial COMPLETO. `totalUses` queda capado a maxTotalUses, y el gate
   *    `totalUses >= maxTotalUses` sigue correcto (true sii el count real llegó al tope).
   */
  private async usageFor(
    promotionId: string,
    userId: string,
    maxTotalUses: number,
  ): Promise<{ totalUses: number; userUses: number }> {
    const [totalUses, userUses] = await Promise.all([
      maxTotalUses > 0
        ? this.prisma.read.promoRedemption
            .findMany({ where: { promotionId }, take: maxTotalUses, select: { id: true } })
            .then((rows) => rows.length)
        : Promise.resolve(0),
      this.prisma.read.promoRedemption.count({ where: { promotionId, userId } }),
    ]);
    return { totalUses, userUses };
  }

  /**
   * Previsualiza el descuento de un código para un usuario sobre un bruto. No muta. Si el código no
   * existe o no aplica, devuelve `valid:false` con un `reason` legible (nunca lanza por negocio).
   */
  async validatePromo(
    rawCode: string,
    userId: string,
    fareCents: number,
  ): Promise<PromoValidation> {
    const code = normalizeCode(rawCode);
    const promo = await this.prisma.read.promotion.findUnique({ where: { code } });
    if (!promo) {
      return {
        code,
        kind: 'FIXED',
        valid: false,
        discountCents: 0,
        reason: reasonMessage('NOT_FOUND'),
      };
    }
    const usage = await this.usageFor(promo.id, userId, promo.maxTotalUses);
    const result = evaluatePromo(promo, fareCents, usage);
    if (!result.valid) {
      return {
        code,
        kind: promo.kind,
        valid: false,
        discountCents: 0,
        reason: reasonMessage(result.reason),
      };
    }
    return { code, kind: promo.kind, valid: true, discountCents: result.discountCents };
  }

  /**
   * Canjea un código para un viaje (idempotente). Re-llamar con la misma `dedupKey` (o la misma
   * tripleta promo/usuario/viaje) devuelve el MISMO canje sin descontar de nuevo. Lanza error claro
   * si el código no existe (404) o no aplica (400: expirado/agotado/no aplica).
   */
  async redeemPromo(input: RedeemInput): Promise<RedeemResult> {
    const code = normalizeCode(input.code);

    // Idempotencia por dedupKey: si ya se canjeó, devolvemos el registro existente.
    const existingByKey = await this.prisma.read.promoRedemption.findUnique({
      where: { dedupKey: input.dedupKey },
    });
    if (existingByKey) {
      return {
        redemptionId: existingByKey.id,
        promotionId: existingByKey.promotionId,
        code: existingByKey.code,
        discountCents: existingByKey.discountCents,
      };
    }

    const promo = await this.prisma.read.promotion.findUnique({ where: { code } });
    if (!promo) throw new NotFoundError(reasonMessage('NOT_FOUND'), { code });

    // Idempotencia por viaje: un mismo viaje no canjea dos veces la misma promo.
    const existingForTrip = await this.prisma.read.promoRedemption.findUnique({
      where: {
        promotionId_userId_tripId: {
          promotionId: promo.id,
          userId: input.userId,
          tripId: input.tripId,
        },
      },
    });
    if (existingForTrip) {
      return {
        redemptionId: existingForTrip.id,
        promotionId: existingForTrip.promotionId,
        code: existingForTrip.code,
        discountCents: existingForTrip.discountCents,
      };
    }

    const usage = await this.usageFor(promo.id, input.userId, promo.maxTotalUses);
    const evaluation = evaluatePromo(promo, input.fareCents, usage);
    if (!evaluation.valid) {
      throw this.invalidError(evaluation.reason, code);
    }
    const discountCents = evaluation.discountCents;

    try {
      return await this.prisma.write.$transaction(async (tx) => {
        const redemption = await tx.promoRedemption.create({
          data: {
            id: uuidv7(),
            promotionId: promo.id,
            code: promo.code,
            userId: input.userId,
            tripId: input.tripId,
            discountCents,
            dedupKey: input.dedupKey,
          },
        });
        const envelope = createEnvelope({
          eventType: 'promo.redeemed',
          producer: 'payment-service',
          dedupKey: input.dedupKey,
          payload: {
            promotionId: promo.id,
            code: promo.code,
            userId: input.userId,
            tripId: input.tripId,
            discountCents,
            at: new Date().toISOString(),
          },
        });
        await enqueueOutbox(tx, envelope, promo.id);
        return {
          redemptionId: redemption.id,
          promotionId: promo.id,
          code: promo.code,
          discountCents,
        };
      });
    } catch (err) {
      // Carrera de doble-submit: el UNIQUE (dedupKey o tripleta) garantiza un único canje.
      if (isUniqueViolation(err)) {
        const dup =
          (await this.prisma.read.promoRedemption.findUnique({
            where: { dedupKey: input.dedupKey },
          })) ??
          (await this.prisma.read.promoRedemption.findUnique({
            where: {
              promotionId_userId_tripId: {
                promotionId: promo.id,
                userId: input.userId,
                tripId: input.tripId,
              },
            },
          }));
        if (dup) {
          return {
            redemptionId: dup.id,
            promotionId: dup.promotionId,
            code: dup.code,
            discountCents: dup.discountCents,
          };
        }
        throw new ConflictError('Canje de promoción duplicado');
      }
      throw err;
    }
  }

  /** Resuelve una promo por código (lectura interna; para el flujo de cobro). */
  async findByCode(rawCode: string): Promise<Promotion | null> {
    return this.prisma.read.promotion.findUnique({ where: { code: normalizeCode(rawCode) } });
  }

  private invalidError(reason: PromoInvalidReason, code: string): ValidationError {
    return new ValidationError(reasonMessage(reason), { code, reason });
  }
}
