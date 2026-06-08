/**
 * OutboxRelay — drena la tabla outbox de chat y publica a Kafka (FOUNDATION §6). Bucle cada 500ms.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventProducer,
  drainOutbox,
  type OutboxStore,
  type EventEnvelope,
} from '@veo/events';
import { PrismaService } from './prisma.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly producer: KafkaEventProducer;
  private readonly store: OutboxStore;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(prisma: PrismaService, config: ConfigService<Env, true>) {
    const kafka = createKafka({
      clientId: 'chat-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
    });
    this.producer = new KafkaEventProducer(kafka);
    this.store = {
      fetchUnpublished: async (limit) => {
        const rows = await prisma.write.outboxEvent.findMany({
          where: { publishedAt: null },
          orderBy: { createdAt: 'asc' },
          take: limit,
        });
        return rows.map((r) => ({
          id: r.id,
          aggregateId: r.aggregateId,
          envelope: r.envelope as unknown as EventEnvelope<unknown>,
          createdAt: r.createdAt,
          publishedAt: r.publishedAt,
        }));
      },
      markPublished: async (ids) => {
        if (ids.length === 0) return;
        await prisma.write.outboxEvent.updateMany({
          where: { id: { in: ids } },
          data: { publishedAt: new Date() },
        });
      },
    };
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
