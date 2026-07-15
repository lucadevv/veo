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
 *    mismo criterio que los mensajes de chat (chat-service · ErasureConsumer).
 *  - `notification_preferences`: la fila de preferencias in-app del usuario (ligada a su `userId`).
 *
 * El ESQUELETO (bootstrap kafka + validar payload contra el registro central + dedup por eventId
 * con la marca DESPUÉS del éxito + logs + relanzar para que kafkajs reintente) vive promovido en
 * ErasureConsumerBase (@veo/events/nest); acá solo queda la config declarativa del dominio.
 * Idempotente: reprocesar es seguro (`deleteMany` es no-op si ya no quedan filas).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventDedupOptions, EventEnvelope } from '@veo/events';
import { ErasureConsumerBase, type ErasureHandlers } from '@veo/events/nest';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { DeviceTokenRepository } from '../devices/device-token.repository';
import { NotificationRepository } from '../engine/notification.repository';
import { SupportTicketRepository } from '../support/support.repository';
import { NotificationPreferenceRepository } from '../notification-prefs/notification-prefs.repository';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'notification-service';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (@veo/events/nest). */
const ERASURE_GROUP_ID = 'notification-service.erasure';

/** Namespace Redis de dedup de notification-service (nunca compartirlo con otro servicio). */
const NOTIFICATION_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:notification:evt:' };

@Injectable()
export class UserDeletedConsumer extends ErasureConsumerBase {
  constructor(
    private readonly devices: DeviceTokenRepository,
    private readonly notifications: NotificationRepository,
    private readonly tickets: SupportTicketRepository,
    private readonly prefs: NotificationPreferenceRepository,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super(
      {
        clientId: KAFKA_CLIENT_ID,
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        groupId: ERASURE_GROUP_ID,
      },
      { redis, options: NOTIFICATION_EVENT_DEDUP },
    );
  }

  /** Config del group de erasure: la LÓGICA de purga vive en los repositorios del dominio. */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: async ({ userId, driverId }) => {
          const recipients = driverId ? [userId, driverId] : [userId];
          const deletedTokens = await this.devices.deleteByUser(userId);
          const deletedNotifications = await this.notifications.eraseByRecipients(recipients);
          const deletedTickets = await this.tickets.deleteByUser(userId);
          const deletedPrefs = await this.prefs.deleteByUser(userId);
          return (
            `Derecho al olvido: usuario ${userId} purgado — ${deletedTokens} token(s) push, ` +
            `${deletedNotifications} notificación(es) (historial + cola pendiente + outbox derivado), ` +
            `${deletedTickets} ticket(s) de soporte, ${deletedPrefs} preferencia(s) de notificación.`
          );
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudo purgar la PII del usuario borrado',
        }),
      },
    };
  }

  // Seam de los specs: invoca el handler directo (sin Kafka) sobre el esqueleto promovido.
  private onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', envelope);
  }
}
