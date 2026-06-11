/**
 * ErasureConsumer — derecho al olvido en chat-service (Ley 29733, BR-S06).
 *
 * UN SOLO consumer Kafka para el group `chat-service.erasure` que registra AMBOS eventos de la
 * cascada de borrado:
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
 * POR QUÉ UN SOLO CONSUMER (no uno por evento): en kafkajs 2.2.4, el líder del consumer group
 * asigna particiones usando SOLO su propia lista de topics (round-robin ignora la suscripción por
 * miembro). Dos consumers en el MISMO groupId suscritos a topics DISTINTOS ('user' vs 'trip') dejan
 * particiones SIN asignar según quién gane la elección de líder → eventos estancados. Un único
 * KafkaEventConsumer que encadena `.on()` suscribe todos los topics del group y elimina el bug.
 *
 * Valida los payloads contra el registro central (@veo/events) y deduplica por `eventId` en Redis
 * con la marca DESPUÉS del éxito (at-least-once). Idempotente: reprocesar es seguro (`deleteMany`
 * es no-op si ya no quedan filas).
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
import { ChatService } from '../chat/chat.service';
import type { Env } from '../config/env.schema';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (ver header). */
const ERASURE_GROUP_ID = 'chat-service.erasure';

/** Namespace Redis de dedup de chat-service (nunca compartirlo con otro servicio). */
const CHAT_EVENT_DEDUP: EventDedupOptions = { keyPrefix: 'veo:chat:evt:' };

interface UserDeletedPayload {
  userId: string;
  driverId?: string;
  at: string;
}

interface TripPiiErasedPayload {
  tripId: string;
  passengerId: string;
  at: string;
}

@Injectable()
export class ErasureConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErasureConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly chat: ChatService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'chat-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: ERASURE_GROUP_ID,
    });
    this.consumer = new KafkaEventConsumer(kafka, ERASURE_GROUP_ID);
    this.consumer
      .on('user.deleted', (e) => this.onUserDeleted(e))
      .on('trip.pii_erased', (e) => this.onTripErased(e));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Suscrito a user.deleted y trip.pii_erased (derecho al olvido)');
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
      // dedup se marca DESPUÉS de borrar con éxito: un fallo deja que kafkajs reintente.
      const outcome = await processEventOnce(this.redis, CHAT_EVENT_DEDUP, envelope.eventId, () =>
        this.chat.eraseUser(userId, driverId),
      );
      if (!outcome.executed) return; // ya procesado
      this.logger.log(
        `Derecho al olvido: ${outcome.result.deletedMessages} mensaje(s) del usuario ${userId} borrados. ` +
          'La conversación completa de cada viaje se purga vía trip.pii_erased.',
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a borrar.
      this.logger.error({ err, userId }, 'No se pudieron borrar los mensajes del usuario borrado');
      throw err;
    }
  }

  private async onTripErased(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('trip.pii_erased');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`trip.pii_erased con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const { tripId } = parsed.data as TripPiiErasedPayload;

    try {
      // El borrado es idempotente (no-op si el viaje ya no tiene mensajes), así que el dedup se
      // marca DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente sin perder la señal.
      const outcome = await processEventOnce(this.redis, CHAT_EVENT_DEDUP, envelope.eventId, () =>
        this.chat.eraseTrip(tripId),
      );
      if (!outcome.executed) return; // ya procesado
      this.logger.log(
        `Derecho al olvido: chat del viaje ${tripId} purgado (${outcome.result.deletedMessages} mensaje(s)).`,
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, tripId }, 'No se pudo purgar el chat del viaje borrado');
      throw err;
    }
  }
}
