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
 * Valida el payload contra el registro central y deduplica por `eventId` en Redis con
 * `processEventOnce` (@veo/events): el dedup se marca DESPUÉS del éxito (un fallo deja que kafkajs
 * reintente; la purga es idempotente).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  processEventOnce,
  schemaForEvent,
  type EventDedupOptions,
  type EventEnvelope,
} from '@veo/events';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { PaymentsService } from '../payments/payments.service';
import { AffiliationsService } from '../affiliations/affiliations.service';
import type { Env } from '../config/env.schema';

/** Namespace Redis de dedup de payment-service (nunca compartirlo con otro servicio). */
const PAYMENT_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:payment:evt:' };

interface UserDeletedPayload {
  userId: string;
  driverId?: string;
  at: string;
}

@Injectable()
export class UserDeletedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserDeletedConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly payments: PaymentsService,
    private readonly affiliations: AffiliationsService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'payment-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'payment-service.erasure',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'payment-service.erasure');
    this.consumer.on('user.deleted', (e) => this.onUserDeleted(e));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Suscrito a user.deleted (derecho al olvido)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('user.deleted');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`user.deleted con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const { userId } = parsed.data as UserDeletedPayload;

    try {
      // La purga en sí es idempotente (sobre-escrituras deterministas), así que el dedup se marca
      // DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente.
      const outcome = await processEventOnce(
        this.redis,
        PAYMENT_EVENT_DEDUP,
        envelope.eventId,
        async () => {
          const { paymentsAnonymized } = await this.payments.eraseUserPii(userId);
          const { erased } = await this.affiliations.eraseUser(userId);
          return { paymentsAnonymized, erased };
        },
      );
      if (!outcome.executed) return; // ya procesado
      const { paymentsAnonymized, erased } = outcome.result;
      this.logger.log(
        `Derecho al olvido: usuario ${userId} → ${paymentsAnonymized} pago(s) anonimizados, ` +
          `afiliación ${erased ? 'purgada' : 'inexistente'}. Registros financieros conservados ` +
          'ANONIMIZADOS (obligación contable).',
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, userId }, 'No se pudo purgar la PII de pagos del usuario borrado');
      throw err;
    }
  }
}
