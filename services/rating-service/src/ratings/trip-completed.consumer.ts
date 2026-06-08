/**
 * Consumidor de `trip.completed` (FOUNDATION §6). Habilita la calificación post-viaje:
 * cuando un viaje se completa, el viaje queda elegible para ser calificado por sus participantes.
 *
 * NOTA DE CONTRATO: el payload de `trip.completed` en @veo/events es
 * { tripId, fareCents, distanceMeters, durationSeconds } y NO incluye driverId/passengerId,
 * por lo que aquí no podemos pre-poblar quién califica a quién. El POST /ratings recibe `ratedId`
 * y `ratedRole` del llamante. Ver README ("Necesidades de contrato compartido").
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKafka, KafkaEventConsumer, type EventEnvelope } from '@veo/events';
import { domainEventsTotal } from '@veo/observability';
import type { Env } from '../config/env.schema';

const GROUP_ID = 'rating-service';

@Injectable()
export class TripCompletedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripCompletedConsumer.name);
  private readonly consumer: KafkaEventConsumer;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(config: ConfigService<Env, true>) {
    const kafka = createKafka({
      clientId: 'rating-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: GROUP_ID,
    });
    this.consumer = new KafkaEventConsumer(kafka, GROUP_ID);
    this.consumer.on('trip.completed', (envelope) => this.onTripCompleted(envelope));
  }

  async onModuleInit(): Promise<void> {
    // Arranque resiliente: si el topic `trip` aún no existe o el broker está cargando, NO se tumba
    // el servicio (REST + gRPC siguen vivos). Se reintenta en segundo plano hasta conectar.
    await this.startWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      await this.consumer.stop();
    } catch (err) {
      this.logger.warn({ err }, 'error al detener el consumidor');
    }
  }

  private async startWithRetry(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.consumer.start();
      this.logger.log(`consumiendo trip.completed (group ${GROUP_ID})`);
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
