/**
 * Consumidor Kafka de `dispatch.match_found` → transición a ASSIGNED (BR-T02).
 * dispatch-service publica el match (conductor elegido); trip-service lo materializa.
 * Idempotente: el servicio ignora reprocesos del mismo conductor ya asignado.
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId = UN consumer con TODOS
 * sus eventos en `handlers()`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schemaForEvent, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { TripsService } from './trips.service';
import type { Env } from '../config/env.schema';

interface MatchFoundPayload {
  tripId: string;
  driverId: string;
  /** Vehículo activo del conductor (best-effort, resuelto por dispatch al aceptar). Puede faltar. */
  vehicleId?: string;
  scoreMs: number;
}

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'trip-service';

/** Group propio del match (no comparte el de PUJA ni el de erasure). */
const DISPATCH_GROUP_ID = 'trip-service.dispatch';

@Injectable()
export class DispatchConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: DISPATCH_GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return { 'dispatch.match_found': (envelope) => this.onMatchFound(envelope) };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')}`;
  }

  private async onMatchFound(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('dispatch.match_found');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('dispatch.match_found con payload inválido; ignorado');
      return;
    }
    const { tripId, driverId, vehicleId } = parsed.data as MatchFoundPayload;
    try {
      await this.trips.assignFromDispatch(tripId, driverId, vehicleId);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; aquí solo registramos para diagnóstico.
      this.logger.error({ err, tripId }, 'No se pudo asignar el viaje desde dispatch');
      throw err;
    }
  }
}
