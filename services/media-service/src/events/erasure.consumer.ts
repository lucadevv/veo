/**
 * ErasureConsumer — derecho al olvido en media-service (Ley 29733, BR-S06).
 *
 * UN SOLO consumer Kafka para el group `media-service.erasure` que registra AMBOS eventos de la
 * cascada de borrado:
 *
 *  - `user.deleted` (identity-service, tombstone definitivo tras la gracia): purga la PII
 *    per-usuario que media-service custodia: el AVATAR del usuario (foto de la persona, key
 *    determinista por usuario en el bucket público).
 *    Degradación honesta — VIDEO DE CABINA: los segmentos (`media_segments`) se indexan por
 *    `tripId`, NO por usuario. media-service no conoce el mapa usuario→viajes (vive en
 *    trip-service) y no puede resolverlo sin un join cross-servicio (prohibido). Por eso el video
 *    NO se purga aquí: lo cierra `trip.pii_erased` (abajo) y el RetentionSweeper (BR-S03).
 *
 *  - `trip.pii_erased` (trip-service, UNO por viaje del usuario borrado): purga la grabación de
 *    ese viaje (objetos S3/MinIO + filas `media_segments` y sus solicitudes de acceso). Cierra el
 *    último hueco de la cascada `user.deleted` para el video de cabina.
 *
 * POR QUÉ UN SOLO CONSUMER (no uno por evento): en kafkajs 2.2.4, el líder del consumer group
 * asigna particiones usando SOLO su propia lista de topics (round-robin ignora la suscripción por
 * miembro). Dos consumers en el MISMO groupId suscritos a topics DISTINTOS ('user' vs 'trip') dejan
 * particiones SIN asignar según quién gane la elección de líder → eventos estancados. Un único
 * KafkaEventConsumer que encadena `.on()` suscribe todos los topics del group y elimina el bug.
 *
 * Valida los payloads contra el registro central (@veo/events) y deduplica por `eventId` en Redis
 * con la marca DESPUÉS del éxito (at-least-once). Idempotente: reprocesar es seguro (los borrados
 * son no-op si ya no hay nada que borrar).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  processEventOnce,
  schemaForEvent,
  type EventEnvelope,
} from '@veo/events';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { AvatarService } from '../media/avatar.service';
import { RecordingService } from '../media/recording.service';
import { MEDIA_EVENT_DEDUP } from './dedup.options';
import type { Env } from '../config/env.schema';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (ver header). */
const ERASURE_GROUP_ID = 'media-service.erasure';

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
    private readonly avatars: AvatarService,
    private readonly recording: RecordingService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'media-service',
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
    const { userId } = parsed.data as UserDeletedPayload;

    try {
      // El borrado en sí es idempotente (deleteObject es no-op si el objeto no existe), así que el
      // dedup se marca DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente.
      const outcome = await processEventOnce(this.redis, MEDIA_EVENT_DEDUP, envelope.eventId, () =>
        this.avatars.eraseUser(userId),
      );
      if (!outcome.executed) return; // ya procesado
      this.logger.log(
        `Derecho al olvido: avatar del usuario ${userId} purgado (${outcome.result.deletedKeys} key(s) tentadas). ` +
          'Video de cabina indexado por tripId: borrado gobernado por RetentionSweeper (BR-S03).',
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, userId }, 'No se pudo purgar el avatar del usuario borrado');
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
      // El borrado es idempotente (no-op si el viaje ya no tiene segmentos), así que el dedup se
      // marca DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente sin perder la señal.
      const outcome = await processEventOnce(this.redis, MEDIA_EVENT_DEDUP, envelope.eventId, () =>
        this.recording.eraseTrip(tripId),
      );
      if (!outcome.executed) return; // ya procesado
      this.logger.log(
        `Derecho al olvido: video del viaje ${tripId} purgado (${outcome.result.purgedSegments} segmento(s)).`,
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, tripId }, 'No se pudo purgar el video del viaje borrado');
      throw err;
    }
  }
}
