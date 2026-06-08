/**
 * OutboxRelay — drena la tabla outbox de panic y publica a Kafka (FOUNDATION §6).
 * Bucle cada 500ms. Idempotente (republicar es seguro: el envelope lleva dedupKey).
 *
 * Este relay es lo que garantiza el BR-S05: panic.triggered se publica sí o sí cuando la
 * transacción de dominio commiteó, sin acoplar el ack al cliente (<800ms) a la latencia de Kafka.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKafka, KafkaEventProducer, drainOutbox } from '@veo/events';
import { PrismaOutboxStore } from '@veo/database';
import { PrismaService } from './prisma.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly producer: KafkaEventProducer;
  private readonly store: PrismaOutboxStore;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(prisma: PrismaService, config: ConfigService<Env, true>) {
    const kafka = createKafka({
      clientId: 'panic-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
    });
    this.producer = new KafkaEventProducer(kafka);
    // OutboxStore sobre el write client (la escritura de dominio pobló el outbox en la misma tx).
    this.store = new PrismaOutboxStore(prisma.write.outboxEvent);
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.timer = setInterval(() => void this.tick(), 500);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.producer.disconnect();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await drainOutbox(this.store, this.producer, 100);
      if (n > 0) this.logger.debug(`outbox: publicados ${n} eventos`);
    } catch (err) {
      this.logger.error({ err }, 'outbox relay falló');
    } finally {
      this.running = false;
    }
  }
}
