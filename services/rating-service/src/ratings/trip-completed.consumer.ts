/**
 * Consumidor de `trip.completed` (FOUNDATION §6). Habilita la calificación post-viaje:
 * cuando un viaje se completa, el viaje queda elegible para ser calificado por sus participantes.
 *
 * NOTA DE CONTRATO: el payload de `trip.completed` en @veo/events es
 * { tripId, fareCents, distanceMeters, durationSeconds } y NO incluye driverId/passengerId,
 * por lo que aquí no podemos pre-poblar quién califica a quién. El POST /ratings recibe `ratedId`
 * y `ratedRole` del llamante. Ver README ("Necesidades de contrato compartido").
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); acá solo se conserva el ARRANQUE RESILIENTE
 * (reintento en segundo plano) sobre ese esqueleto.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { domainEventsTotal } from '@veo/observability';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio (también su groupId de consumo). */
const KAFKA_CLIENT_ID = 'rating-service';
const GROUP_ID = 'rating-service';

@Injectable()
export class TripCompletedConsumer extends KafkaConsumerBootstrap {
  constructor(config: ConfigService<Env, true>) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /**
   * TODOS los eventos del group, en un solo record (único punto de registro). El BOOTSTRAP resiliente
   * (startWithRetry con backoff ante errores transitorios de Kafka) + el teardown viven promovidos en
   * KafkaConsumerBootstrap.onModuleInit/onModuleDestroy — esta subclase solo declara su config
   * (handlers + subscriptionLog), igual que PricingCacheConsumer. NO re-implementa el retry.
   */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { 'trip.completed': (envelope) => this.onTripCompleted(envelope) };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `consumiendo ${eventTypes.join(', ')} (group ${GROUP_ID})`;
  }

  private async onTripCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId?: string };
    domainEventsTotal.inc({ event: 'trip.completed', result: 'consumed' });
    this.logger.debug(`viaje completado y elegible para calificación: ${payload.tripId ?? '?'}`);
    return Promise.resolve();
  }
}
