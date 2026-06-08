/**
 * UserDeletedConsumer — derecho al olvido (Ley 29733, BR-S06).
 *
 * Consume `user.deleted` (lo emite identity-service al aplicar el tombstone definitivo tras la
 * gracia) y purga la PII per-usuario que media-service custodia: el AVATAR del usuario (foto de la
 * persona, key determinista por usuario en el bucket público).
 *
 * Degradación honesta — VIDEO DE CABINA: los segmentos (`media_segments`) se indexan por `tripId`,
 * NO por usuario. media-service no conoce el mapa usuario→viajes (vive en trip-service) y no puede
 * resolverlo sin un join cross-servicio (prohibido). Por eso el video NO se purga aquí: su borrado
 * lo gobierna el RetentionSweeper (BR-S03) por `retentionUntil`. Se registra esta limitación.
 *
 * Valida el payload contra el registro central y deduplica por `eventId` en Redis (idempotente:
 * reprocesar el evento es seguro; además `deleteObject` es no-op si el objeto ya no existe).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  schemaForEvent,
  type EventEnvelope,
} from '@veo/events';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { AvatarService } from '../media/avatar.service';
import type { Env } from '../config/env.schema';

const DEDUP_TTL_SECONDS = 86_400; // 24h

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
    private readonly avatars: AvatarService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'media-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'media-service.erasure',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'media-service.erasure');
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

    // Fast-path de deduplicación: si ya procesamos este eventId, salimos (idempotencia barata).
    const dedupKey = `veo:media:evt:${envelope.eventId}`;
    if ((await this.redis.get(dedupKey)) !== null) return;

    try {
      // El borrado en sí es idempotente (deleteObject es no-op si el objeto no existe), así que
      // marcamos el dedup DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente.
      const { deletedKeys } = await this.avatars.eraseUser(userId);
      await this.redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS);
      this.logger.log(
        `Derecho al olvido: avatar del usuario ${userId} purgado (${deletedKeys} key(s) tentadas). ` +
          'Video de cabina indexado por tripId: borrado gobernado por RetentionSweeper (BR-S03).',
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, userId }, 'No se pudo purgar el avatar del usuario borrado');
      throw err;
    }
  }
}
