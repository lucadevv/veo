/**
 * Consumidor Kafka de `dispatch.match_found` → transición a ASSIGNED (BR-T02).
 * dispatch-service publica el match (conductor elegido); trip-service lo materializa.
 * Idempotente: el servicio ignora reprocesos del mismo conductor ya asignado.
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  schemaForEvent,
  type EventEnvelope,
} from '@veo/events';
import { TripsService } from './trips.service';
import type { Env } from '../config/env.schema';

interface MatchFoundPayload {
  tripId: string;
  driverId: string;
  scoreMs: number;
}

@Injectable()
export class DispatchConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'trip-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'trip-service.dispatch',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'trip-service.dispatch');
    this.consumer.on('dispatch.match_found', (envelope) => this.onMatchFound(envelope));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Suscrito a dispatch.match_found');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onMatchFound(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('dispatch.match_found');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('dispatch.match_found con payload inválido; ignorado');
      return;
    }
    const { tripId, driverId } = parsed.data as MatchFoundPayload;
    try {
      await this.trips.assignFromDispatch(tripId, driverId);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; aquí solo registramos para diagnóstico.
      this.logger.error({ err, tripId }, 'No se pudo asignar el viaje desde dispatch');
      throw err;
    }
  }
}
