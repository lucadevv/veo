/**
 * Consumidor Kafka de identity para la suspensión de conductores (cierre del lazo de cumplimiento).
 *  - `fleet.driver_suspended` → fleet-service suspende al conductor cuando un documento crítico vence;
 *    identity escribe `Driver.suspendedAt`, que es lo que el gate de inicio de turno (startShift) lee
 *    para BLOQUEAR el turno (BR-I02). Sin este consumidor la suspensión por documento vencido era
 *    código muerto: nadie escribía `suspendedAt`.
 *
 * El eventType casa con EVENT_SCHEMAS (`fleet.driver_suspended`, guion bajo) → el KafkaEventConsumer YA
 * valida el payload por nosotros; igual revalidamos acá con el zod `fleetDriverSuspended` (defensa en
 * profundidad) para extraer los campos tipados.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKafka, KafkaEventConsumer, fleetDriverSuspended, type EventEnvelope } from '@veo/events';
import { DriversService } from './drivers.service';
import type { Env } from '../config/env.schema';

/** eventType en el wire que emite fleet-service (ver services/fleet-service/src/events/fleet-events.ts). */
const DRIVER_SUSPENDED = 'fleet.driver_suspended';

@Injectable()
export class DriverSuspensionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriverSuspensionConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly drivers: DriversService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'identity-service-driver-suspension',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'identity-service-driver-suspension',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'identity-service-driver-suspension');
    // on() resuelve el topic vía topicForEvent → 'fleet'; el dispatch interno casa por envelope.eventType.
    this.consumer.on(DRIVER_SUSPENDED, (env) => this.onDriverSuspended(env));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log(`Consumidor de suspensión de conductores iniciado (${DRIVER_SUSPENDED})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onDriverSuspended(env: EventEnvelope<unknown>): Promise<void> {
    const parsed = fleetDriverSuspended.safeParse(env.payload);
    if (!parsed.success) {
      this.logger.warn(`${DRIVER_SUSPENDED} con payload inválido; descartado`);
      return;
    }
    const { driverId, suspendedAt, reason } = parsed.data;
    const at = new Date(suspendedAt);
    if (Number.isNaN(at.getTime())) {
      this.logger.warn(`${DRIVER_SUSPENDED} con suspendedAt inválido (${suspendedAt}); descartado`);
      return;
    }
    try {
      const applied = await this.drivers.suspendByFleet(driverId, at);
      if (applied) {
        this.logger.log(`Conductor ${driverId} suspendido (${reason})`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló la suspensión del conductor ${driverId}`);
      throw err; // que Kafka reintente; suspendByFleet es idempotente.
    }
  }
}
