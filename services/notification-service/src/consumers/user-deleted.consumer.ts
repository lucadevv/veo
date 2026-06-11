/**
 * UserDeletedConsumer — derecho al olvido (Ley 29733, BR-S06).
 *
 * Consume `user.deleted` (lo emite identity-service al aplicar el tombstone definitivo tras la
 * gracia) y purga la PII per-usuario que notification-service custodia:
 *  - `device_tokens`: los tokens de push del usuario (direcciones de dispositivo).
 *  - `notifications`: historial + COLA pendiente (las filas PENDING son la cola del worker; sus
 *    payloads llevan `to` = token/teléfono y vars con nombres). Si la identidad era conductor,
 *    también las dirigidas a su `driverId` (recipientId de los pushes de conductor).
 *  - `outbox_events` derivados de esas notificaciones (envelopes notification.sent/failed con `to`).
 *  - `support_tickets`: `subject`/`body` son texto libre del usuario (PII en sí mismo) → borrado duro,
 *    mismo criterio que los mensajes de chat (chat-service · UserDeletedConsumer).
 *
 * Valida el payload contra el registro central y deduplica por `eventId` en Redis (idempotente:
 * reprocesar el evento es seguro; además `deleteMany` es no-op si ya no quedan filas).
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
import { DeviceTokenRepository } from '../devices/device-token.repository';
import { NotificationRepository } from '../engine/notification.repository';
import { SupportTicketRepository } from '../support/support.repository';
import type { Env } from '../config/env.schema';

/** Namespace Redis de dedup de notification-service (nunca compartirlo con otro servicio). */
const NOTIFICATION_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:notification:evt:' };

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
    private readonly devices: DeviceTokenRepository,
    private readonly notifications: NotificationRepository,
    private readonly tickets: SupportTicketRepository,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'notification-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'notification-service.erasure',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'notification-service.erasure');
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
    const { userId, driverId } = parsed.data as UserDeletedPayload;

    try {
      // El borrado en sí es idempotente (deleteMany es no-op si ya no quedan filas), así que el
      // dedup se marca DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente.
      const recipients = driverId ? [userId, driverId] : [userId];
      const outcome = await processEventOnce(
        this.redis,
        NOTIFICATION_EVENT_DEDUP,
        envelope.eventId,
        async () => {
          const deletedTokens = await this.devices.deleteByUser(userId);
          const deletedNotifications = await this.notifications.eraseByRecipients(recipients);
          const deletedTickets = await this.tickets.deleteByUser(userId);
          return { deletedTokens, deletedNotifications, deletedTickets };
        },
      );
      if (!outcome.executed) return; // ya procesado
      const { deletedTokens, deletedNotifications, deletedTickets } = outcome.result;
      this.logger.log(
        `Derecho al olvido: usuario ${userId} purgado — ${deletedTokens} token(s) push, ` +
          `${deletedNotifications} notificación(es) (historial + cola pendiente + outbox derivado), ` +
          `${deletedTickets} ticket(s) de soporte.`,
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, userId }, 'No se pudo purgar la PII del usuario borrado');
      throw err;
    }
  }
}
