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
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(config: ConfigService<Env, true>) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { 'trip.completed': (envelope) => this.onTripCompleted(envelope) };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `consumiendo ${eventTypes.join(', ')} (group ${GROUP_ID})`;
  }

  override async onModuleInit(): Promise<void> {
    // Arranque resiliente: si el topic `trip` aún no existe o el broker está cargando, NO se tumba
    // el servicio (REST + gRPC siguen vivos). Se reintenta en segundo plano hasta conectar.
    await this.startWithRetry();
  }

  override async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      await super.onModuleDestroy();
    } catch (err) {
      this.logger.warn({ err }, 'error al detener el consumidor');
    }
  }

  private async startWithRetry(): Promise<void> {
    if (this.stopped) return;
    try {
      // Registro de handlers + start + log de suscripción (esqueleto promovido). Reintentar es
      // seguro: el registro re-escribe las mismas entradas y start vuelve a conectar.
      await super.onModuleInit();
    } catch (err) {
      this.logger.warn({ err }, 'no se pudo iniciar el consumidor de trip.completed; reintentando en 5s');
      this.retryTimer = setTimeout(() => void this.startWithRetry(), 5000);
    }
  }

  private async onTripCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId?: string };
    domainEventsTotal.inc({ event: 'trip.completed', result: 'consumed' });
    this.logger.debug(`viaje completado y elegible para calificación: ${payload.tripId ?? '?'}`);
    return Promise.resolve();
  }
}
