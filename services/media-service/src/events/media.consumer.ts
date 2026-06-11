/**
 * MediaEventConsumer — consume los eventos de dominio que disparan la grabación (BR-S01).
 *
 *  - `trip.started`     → inicia grabación + publica `media.recording_started`.
 *  - `trip.completed`   → finaliza grabación + publica `media.archived`.
 *  - `panic.triggered`  → fuerza grabación (aunque el viaje no esté IN_PROGRESS) y fija retención
 *                         indefinida (BR-S01 excepción + BR-S03).
 *
 * Valida el payload contra el registro central (@veo/events) y descarta lo inválido. Deduplica por
 * `eventId` en Redis con la marca DESPUÉS del éxito (at-least-once): si un handler falla, el dedup
 * NO se escribe y kafkajs reintenta sin perder el evento — un `panic.triggered` jamás se descarta
 * por un fallo transitorio. Reprocesar es seguro: los handlers de RecordingService son idempotentes
 * (segmento abierto por viaje / finish no-op / update al mismo valor).
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
import { RecordingService } from '../media/recording.service';
import { MEDIA_EVENT_DEDUP } from './dedup.options';
import type { Env } from '../config/env.schema';

@Injectable()
export class MediaEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaEventConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly recording: RecordingService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'media-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'media-service',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'media-service');
    this.consumer
      .on('trip.started', (e) => this.handle(e, (env) => this.onTripStarted(env)))
      .on('trip.completed', (e) => this.handle(e, (env) => this.onTripCompleted(env)))
      .on('panic.triggered', (e) => this.handle(e, (env) => this.onPanicTriggered(env)));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Consumiendo trip.started, trip.completed, panic.triggered');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  /** Valida payload + delega con dedup por eventId marcado DESPUÉS del éxito. */
  private async handle(
    envelope: EventEnvelope<unknown>,
    fn: (envelope: EventEnvelope<unknown>) => Promise<void>,
  ): Promise<void> {
    const schema = schemaForEvent(envelope.eventType);
    if (schema) {
      const parsed = schema.safeParse(envelope.payload);
      if (!parsed.success) {
        this.logger.warn(`Payload inválido para ${envelope.eventType} (eventId=${envelope.eventId})`);
        return;
      }
    }
    try {
      // Mismo esqueleto que ErasureConsumer: el dedup se marca DESPUÉS de procesar con éxito.
      // Un fallo deja que kafkajs reintente sin perder el evento.
      await processEventOnce(this.redis, MEDIA_EVENT_DEDUP, envelope.eventId, () => fn(envelope));
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, el reintento volverá a procesar.
      this.logger.error(
        { err, eventType: envelope.eventType },
        `No se pudo procesar ${envelope.eventType} (eventId=${envelope.eventId}); kafkajs reintentará`,
      );
      throw err;
    }
  }

  private async onTripStarted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string; startedAt: string };
    await this.recording.startForTrip(payload.tripId, new Date(payload.startedAt));
  }

  private async onTripCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string };
    await this.recording.finishForTrip(payload.tripId, new Date(envelope.occurredAt));
  }

  private async onPanicTriggered(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string; triggeredAt: string };
    await this.recording.onPanic(payload.tripId, new Date(payload.triggeredAt));
  }
}
