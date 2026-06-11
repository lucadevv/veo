/**
 * UserDeletedConsumer — derecho al olvido (Ley 29733, BR-S06) en payment-service (S7c).
 *
 * Consume `user.deleted` (lo emite identity-service al aplicar el tombstone definitivo tras la
 * gracia) y materializa la cascada de borrado del dinero:
 *  - Payments del usuario: `payerRef` (teléfono/token del pagador en el riel) → placeholder
 *    irreversible (deletedPlaceholder de @veo/database).
 *  - WalletAffiliation: baja en el proveedor (best-effort) + walletUid/phoneMasked/documentMasked
 *    → null, status REVOKED.
 *
 * DEGRADACIÓN HONESTA — registros financieros: payments, refunds, payouts (montos, fechas, estados,
 * ids) NO se borran: obligación legal contable. Se ANONIMIZAN (la PII se purga, el libro queda).
 *
 * El ESQUELETO (bootstrap kafka + validar payload contra el registro central + dedup por eventId
 * con la marca DESPUÉS del éxito + logs + relanzar para que kafkajs reintente) vive promovido en
 * ErasureConsumerBase (@veo/events/nest); acá solo queda la config declarativa del dominio.
 * La purga es idempotente (sobre-escrituras deterministas).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventDedupOptions, EventEnvelope } from '@veo/events';
import { ErasureConsumerBase, type ErasureHandlers } from '@veo/events/nest';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { PaymentsService } from '../payments/payments.service';
import { AffiliationsService } from '../affiliations/affiliations.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'payment-service';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (@veo/events/nest). */
const ERASURE_GROUP_ID = 'payment-service.erasure';

/** Namespace Redis de dedup de payment-service (nunca compartirlo con otro servicio). */
const PAYMENT_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:payment:evt:' };

@Injectable()
export class UserDeletedConsumer extends ErasureConsumerBase {
  constructor(
    private readonly payments: PaymentsService,
    private readonly affiliations: AffiliationsService,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super(
      {
        clientId: KAFKA_CLIENT_ID,
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        groupId: ERASURE_GROUP_ID,
      },
      { redis, options: PAYMENT_EVENT_DEDUP },
    );
  }

  /** Config del group de erasure: la LÓGICA de purga vive en Payments/AffiliationsService. */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: async ({ userId }) => {
          const { paymentsAnonymized } = await this.payments.eraseUserPii(userId);
          const { erased } = await this.affiliations.eraseUser(userId);
          return (
            `Derecho al olvido: usuario ${userId} → ${paymentsAnonymized} pago(s) anonimizados, ` +
            `afiliación ${erased ? 'purgada' : 'inexistente'}. Registros financieros conservados ` +
            'ANONIMIZADOS (obligación contable).'
          );
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudo purgar la PII de pagos del usuario borrado',
        }),
      },
    };
  }

  // Seam de los specs: invoca el handler directo (sin Kafka) sobre el esqueleto promovido.
  private onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', envelope);
  }
}
