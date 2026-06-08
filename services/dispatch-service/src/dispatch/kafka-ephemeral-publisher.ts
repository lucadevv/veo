/**
 * Implementación de producción de `EphemeralEventPublisher` (B3): publica DIRECTO a Kafka vía el
 * `KafkaEventProducer` de @veo/events, sin pasar por el outbox transaccional de Postgres.
 *
 * Mantiene su propio productor Kafka idempotente (mismo wrapper que usa el OutboxRelay para los
 * durables). El topic lo resuelve `topicForEvent` dentro del producer a partir del eventType
 * (`dispatch.offered` → topic `dispatch`), el MISMO topic del que consume driver-bff.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventProducer,
  type EventEnvelope,
  type EventType,
  type EventPayload,
} from '@veo/events';
import type { Env } from '../config/env.schema';
import type { EphemeralEventPublisher } from './ephemeral-event.port';

@Injectable()
export class KafkaEphemeralPublisher
  implements EphemeralEventPublisher, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KafkaEphemeralPublisher.name);
  private readonly producer: KafkaEventProducer;
  private connected = false;

  constructor(config: ConfigService<Env, true>) {
    const kafka = createKafka({
      clientId: 'dispatch-service-ephemeral',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(',').map((b) => b.trim()),
    });
    this.producer = new KafkaEventProducer(kafka);
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
  }

  async publish<T extends EventType>(
    envelope: EventEnvelope<EventPayload<T>>,
    key: string,
  ): Promise<void> {
    await this.producer.publish(envelope, key);
  }
}
