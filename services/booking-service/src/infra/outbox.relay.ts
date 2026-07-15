/**
 * Wiring del OutboxRelay compartido (@veo/database) — drena la tabla outbox del booking-service y publica
 * a Kafka (FOUNDATION §6, topic 'booking'). Acá vive SOLO lo que varía por servicio: clientId Kafka +
 * schema Prisma (advisory lock). El esqueleto (bucle, batch, drenado vía @veo/events, logs) es el helper
 * compartido — idéntico al de identity-service.
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay, outboxRelayConfigFromEnv } from '@veo/database';
import { PrismaService } from './prisma.service';
import type { Env } from '../config/env.schema';

export const outboxRelayProvider: Provider = {
  provide: OutboxRelay,
  inject: [PrismaService, ConfigService],
  useFactory: (prisma: PrismaService, config: ConfigService<Env, true>) =>
    new OutboxRelay({
      clientId: 'booking-service',
      schema: 'booking',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      // Write client: la escritura de dominio pobló el outbox en la misma transacción.
      prisma: prisma.write,
      logger: new Logger(OutboxRelay.name),
      // Perillas del relay desde el ConfigService validado (batch/stale/concurrency/timeout). Cero números mágicos.
      ...outboxRelayConfigFromEnv(config),
    }),
};
