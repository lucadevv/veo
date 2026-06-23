/**
 * Consumidor Kafka de rating-service (groupId `rating-service`). Bajo la REGLA DE ORO (un groupId = UN consumer
 * con TODOS sus eventos en `handlers()`), este consumer agrupa los eventos que rating consume:
 *
 *  - `trip.completed` (FOUNDATION §6): habilita la calificación post-viaje — el viaje queda elegible para que
 *    sus participantes lo califiquen. (El payload NO incluye driverId/passengerId, así que aquí no se pre-puebla
 *    quién califica a quién; el POST /ratings recibe `ratedId`/`ratedRole` del llamante.)
 *
 *  - `driver.reactivated` (evento de DOMINIO de identity): el operador levantó una suspensión del conductor.
 *    rating LIMPIA el flag STICKY del agregado (`flagged=false, flagReason=null`) y ACTIVA el período de gracia
 *    para que SOLO la PRÓXIMA reseña mala (no el cron) pueda RE-emitir 'suspension' y re-suspender (cierra la fuga
 *    del override = inmunidad permanente). Ver RatingsService.clearRatingFlag para la raíz completa. topicForEvent
 *    mapea `driver.reactivated` (y el resto de `driver.*` de CICLO DE VIDA, de baja frecuencia) al topic 'driver' →
 *    este consumer queda suscrito a DOS topics ('trip' + 'driver') en el MISMO groupId (un consumer / múltiples
 *    topics: el patrón soportado por el bootstrap, no la REGLA DE ORO que prohíbe lo inverso). El FIREHOSE de GPS
 *    (`driver.location_updated`, ~1 ping/15s por conductor online) NO está en 'driver': vive aislado en su propio
 *    topic ('driver-location', ver topicForEvent en @veo/events) → rating ya NO deserializa el firehose que no maneja.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + arranque resiliente con backoff) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); esta subclase solo declara su config (handlers + subscriptionLog).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { driverReactivated, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { domainEventsTotal } from '@veo/observability';
import type { Env } from '../config/env.schema';
import { RatingsService } from './ratings.service';

/** clientId kafkajs de este servicio (también su groupId de consumo). */
const KAFKA_CLIENT_ID = 'rating-service';
const GROUP_ID = 'rating-service';

/** eventTypes del wire. `driver.reactivated` lo emite identity por OUTBOX al levantar una suspensión. */
const TRIP_COMPLETED = 'trip.completed';
const DRIVER_REACTIVATED = 'driver.reactivated';

@Injectable()
export class TripCompletedConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly ratings: RatingsService,
    config: ConfigService<Env, true>,
  ) {
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
    return {
      [TRIP_COMPLETED]: (envelope) => this.onTripCompleted(envelope),
      [DRIVER_REACTIVATED]: (envelope) => this.onDriverReactivated(envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `consumiendo ${eventTypes.join(', ')} (group ${GROUP_ID})`;
  }

  private async onTripCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId?: string };
    domainEventsTotal.inc({ event: TRIP_COMPLETED, result: 'consumed' });
    this.logger.debug(`viaje completado y elegible para calificación: ${payload.tripId ?? '?'}`);
    return Promise.resolve();
  }

  /**
   * El operador reactivó al conductor (`driver.reactivated`). LIMPIA el flag sticky del agregado de rating para
   * que la próxima reseña mala pueda re-disparar la auto-suspensión (raíz en RatingsService.clearRatingFlag).
   * El KafkaEventConsumer YA validó el payload contra EVENT_SCHEMAS; igual revalidamos con el zod `driverReactivated`
   * (defensa en profundidad) para extraer el `driverId` tipado. Idempotente y con guard de agregado inexistente.
   */
  private async onDriverReactivated(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = driverReactivated.safeParse(envelope.payload);
    if (!parsed.success) {
      domainEventsTotal.inc({ event: DRIVER_REACTIVATED, result: 'invalid' });
      this.logger.warn(`${DRIVER_REACTIVATED} con payload inválido; descartado`);
      return;
    }
    const { driverId } = parsed.data;
    try {
      const cleared = await this.ratings.clearRatingFlag(driverId);
      domainEventsTotal.inc({ event: DRIVER_REACTIVATED, result: 'consumed' });
      if (cleared) {
        this.logger.log(`Flag de rating limpiado para el conductor ${driverId} tras reactivación`);
      }
    } catch (err) {
      this.logger.error({ err }, `Falló la limpieza del flag de rating del conductor ${driverId}`);
      throw err; // que Kafka reintente; clearRatingFlag es idempotente.
    }
  }
}
