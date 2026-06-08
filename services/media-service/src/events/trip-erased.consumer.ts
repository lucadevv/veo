/**
 * TripErasedConsumer — derecho al olvido del VIDEO DE CABINA (Ley 29733, BR-S06).
 *
 * Cierra el último hueco de borrado de la cascada `user.deleted`: el video de cabina lo custodia
 * media-service indexado por `tripId`, y media-service NO puede resolver el mapa usuario→viajes sin
 * un join cross-servicio (prohibido). El dominó: trip-service consume `user.deleted`, anonimiza los
 * viajes del usuario y emite UN `trip.pii_erased` por viaje afectado; este consumidor lo recibe y
 * purga la grabación de ese viaje (objetos S3/MinIO + filas `media_segments` y sus solicitudes de
 * acceso).
 *
 * Valida el payload contra el registro central (@veo/events) y deduplica por `eventId` en Redis.
 * Idempotente: reprocesar es seguro (dedup + el borrado es no-op si el viaje ya no tiene segmentos).
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
import { RecordingService } from '../media/recording.service';
import type { Env } from '../config/env.schema';

const DEDUP_TTL_SECONDS = 86_400; // 24h

interface TripPiiErasedPayload {
  tripId: string;
  passengerId: string;
  at: string;
}

@Injectable()
export class TripErasedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripErasedConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly recording: RecordingService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'media-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'media-service.erasure',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'media-service.erasure');
    this.consumer.on('trip.pii_erased', (e) => this.onTripErased(e));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Suscrito a trip.pii_erased (derecho al olvido: purga de video de cabina)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onTripErased(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('trip.pii_erased');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`trip.pii_erased con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const { tripId } = parsed.data as TripPiiErasedPayload;

    // Fast-path de deduplicación: si ya procesamos este eventId, salimos (idempotencia barata).
    const dedupKey = `veo:media:evt:${envelope.eventId}`;
    if ((await this.redis.get(dedupKey)) !== null) return;

    try {
      // El borrado es idempotente (no-op si el viaje ya no tiene segmentos), así que marcamos el
      // dedup DESPUÉS de purgar con éxito: un fallo deja que kafkajs reintente sin perder la señal.
      const { purgedSegments } = await this.recording.eraseTrip(tripId);
      await this.redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS);
      this.logger.log(
        `Derecho al olvido: video del viaje ${tripId} purgado (${purgedSegments} segmento(s)).`,
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, así que el reintento volverá a purgar.
      this.logger.error({ err, tripId }, 'No se pudo purgar el video del viaje borrado');
      throw err;
    }
  }
}
