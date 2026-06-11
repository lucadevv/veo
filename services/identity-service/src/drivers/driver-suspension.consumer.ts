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
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS
 * sus eventos en `handlers()`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fleetDriverSuspended, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { DriversService } from './drivers.service';
import type { Env } from '../config/env.schema';

/** eventType en el wire que emite fleet-service (ver services/fleet-service/src/events/fleet-events.ts). */
const DRIVER_SUSPENDED = 'fleet.driver_suspended';

/** clientId kafkajs de este consumer (también su groupId, propio: no comparte el de referidos). */
const KAFKA_CLIENT_ID = 'identity-service-driver-suspension';
const GROUP_ID = 'identity-service-driver-suspension';

@Injectable()
export class DriverSuspensionConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly drivers: DriversService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /** on() resuelve el topic vía topicForEvent → 'fleet'; el dispatch interno casa por envelope.eventType. */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { [DRIVER_SUSPENDED]: (env) => this.onDriverSuspended(env) };
  }

  protected override subscriptionLog(): string {
    return `Consumidor de suspensión de conductores iniciado (${DRIVER_SUSPENDED})`;
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
