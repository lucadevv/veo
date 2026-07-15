/**
 * Wiring del OutboxRelay compartido (@veo/database) — drena la tabla outbox de panic y publica
 * a Kafka (FOUNDATION §6). Acá vive SOLO lo que varía por servicio: clientId Kafka + schema
 * Prisma (advisory lock). El esqueleto (bucle 500ms, batch, drainOutbox vía @veo/events,
 * manejo de error, logs) es el helper promovido — idéntico al histórico.
 *
 * BR-S05: panic.triggered se publica sí o sí cuando la transacción de dominio commiteó, sin
 * acoplar el ack al cliente (<800ms) a la latencia de Kafka.
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
      clientId: 'panic-service',
      schema: 'panic',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      // Write client: la escritura de dominio pobló el outbox en la misma transacción.
      prisma: prisma.write,
      logger: new Logger(OutboxRelay.name),
      // Perillas del relay desde el ConfigService validado (batch/stale/concurrency/timeout). Cero números mágicos.
      ...outboxRelayConfigFromEnv(config),
    }),
};
