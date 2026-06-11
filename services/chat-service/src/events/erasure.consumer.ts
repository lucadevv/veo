/**
 * ErasureConsumer — derecho al olvido en chat-service (Ley 29733, BR-S06).
 *
 * UN SOLO consumer Kafka para el group `chat-service.erasure` que registra AMBOS eventos de la
 * cascada de borrado (regla de oro y esqueleto promovido: ver @veo/events/nest):
 *
 *  - `user.deleted` (identity-service, tombstone definitivo tras la gracia): borra los MENSAJES DE
 *    CHAT escritos por la identidad borrada. El `body` es texto libre redactado por el usuario (PII
 *    en sí mismo, incluso de viajes con menores), así que se borra duro — anonimizar solo `senderId`
 *    dejaría la PII intacta. Los mensajes del otro participante son SU dato y se conservan hasta su
 *    propio borrado o el `trip.pii_erased` del viaje.
 *
 *  - `trip.pii_erased` (trip-service, UNO por viaje del usuario borrado): purga TODA la conversación
 *    de ese viaje (ambos lados). El chat cuelga del `tripId` y su texto libre (direcciones, nombres)
 *    es PII del viaje borrado — mismo criterio que media-service con el video de cabina.
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
import { ChatService } from '../chat/chat.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'chat-service';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (ver header). */
const ERASURE_GROUP_ID = 'chat-service.erasure';

/** Namespace Redis de dedup de chat-service (nunca compartirlo con otro servicio). */
const CHAT_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:chat:evt:' };

@Injectable()
export class ErasureConsumer extends ErasureConsumerBase {
  constructor(
    private readonly chat: ChatService,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super(
      {
        clientId: KAFKA_CLIENT_ID,
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        groupId: ERASURE_GROUP_ID,
      },
      { redis, options: CHAT_EVENT_DEDUP },
    );
  }

  /** Config del group de erasure: la LÓGICA de borrado vive en ChatService (dominio). */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: async ({ userId, driverId }) => {
          const { deletedMessages } = await this.chat.eraseUser(userId, driverId);
          return (
            `Derecho al olvido: ${deletedMessages} mensaje(s) del usuario ${userId} borrados. ` +
            'La conversación completa de cada viaje se purga vía trip.pii_erased.'
          );
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudieron borrar los mensajes del usuario borrado',
        }),
      },
      'trip.pii_erased': {
        erase: async ({ tripId }) => {
          const { deletedMessages } = await this.chat.eraseTrip(tripId);
          return `Derecho al olvido: chat del viaje ${tripId} purgado (${deletedMessages} mensaje(s)).`;
        },
        logError: ({ tripId }) => ({
          context: { tripId },
          message: 'No se pudo purgar el chat del viaje borrado',
        }),
      },
    };
  }

  // Seams de los specs: invocan cada handler directo (sin Kafka) sobre el esqueleto promovido.
  private onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', envelope);
  }

  private onTripErased(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('trip.pii_erased', envelope);
  }
}
