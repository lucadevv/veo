/**
 * Sonda de salud Kafka para readiness. Kafka es una dependencia DURA del booking-service: el OutboxRelay
 * drena la tabla outbox al topic 'booking' (FOUNDATION §6) — si Kafka está caído, los eventos de dominio
 * (booking.published/requested/approved) no salen y los consumidores aguas abajo no avanzan. Por eso la
 * sonda /health/ready debe reflejar el estado del broker, no solo el de Postgres.
 *
 * El OutboxRelay es dueño de SU productor (ciclo de vida privado): no se reusa acá para no acoplar el
 * readiness al relay ni abrir su productor a usos externos. En su lugar, esta sonda mantiene un Admin client
 * kafkajs DEDICADO y liviano que hace `describeCluster()` (round-trip real al broker) — espeja el patrón del
 * provider Redis (un cliente propio, `ping`-eable). Cero strings mágicos: clientId + brokers vienen del env.
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKafka } from '@veo/events';
import type { Admin } from 'kafkajs';
import type { Env } from '../config/env.schema';

/** Token DI del cliente de salud Kafka (Symbol → cero strings mágicos en el grafo de inyección). */
export const KAFKA_HEALTH = Symbol('KAFKA_HEALTH');

/** clientId del Admin de readiness (sufijo dedicado para distinguirlo del productor del relay en los logs). */
export const KAFKA_HEALTH_CLIENT_ID = 'booking-service-health' as const;

/**
 * Cliente de salud Kafka: encapsula un Admin kafkajs dedicado y expone `isHealthy()` (describeCluster). El
 * Admin se conecta perezosamente en la 1ª sonda y se reusa; `disconnect()` lo cierra en el shutdown del Nest.
 */
export class KafkaHealthClient {
  private readonly logger = new Logger('KafkaHealth');
  private readonly admin: Admin;
  private connected = false;

  constructor(brokers: string[], clientId: string = KAFKA_HEALTH_CLIENT_ID) {
    this.admin = createKafka({ clientId, brokers }).admin();
  }

  /** Round-trip real al broker. `true` si el cluster responde; `false` si no (la sonda lo reporta no-listo). */
  async isHealthy(): Promise<boolean> {
    try {
      if (!this.connected) {
        await this.admin.connect();
        this.connected = true;
      }
      const cluster = await this.admin.describeCluster();
      return cluster.brokers.length > 0;
    } catch (err) {
      // Reset del flag: un fallo puede dejar el Admin en estado raro; la próxima sonda reintenta connect.
      this.connected = false;
      this.logger.warn(`Kafka readiness check falló: ${(err as Error).message}`);
      return false;
    }
  }

  /** Cierra el Admin en el shutdown. Nest invoca `onModuleDestroy` duck-typed en cualquier provider. */
  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /** Cierra el Admin (idempotente). */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.admin.disconnect();
      this.connected = false;
    }
  }
}

/**
 * Provider del cliente de salud Kafka. Brokers desde el env (KAFKA_BROKERS, ya spliteado como en el relay).
 * Singleton del CoreModule, exportado para que el readiness de app.module lo inyecte (espeja REDIS).
 */
export const kafkaHealthProvider: Provider = {
  provide: KAFKA_HEALTH,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): KafkaHealthClient =>
    new KafkaHealthClient(config.getOrThrow<string>('KAFKA_BROKERS').split(',')),
};
