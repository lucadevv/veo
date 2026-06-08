/**
 * Consumidor Kafka de `user.deleted` → anonimiza la PII de localización de los viajes del usuario
 * (BR-S06 derecho al olvido, Ley 29733). identity-service emite este evento cuando el sweeper
 * aplica el tombstone definitivo tras la gracia; aquí materializamos la cascada de borrado.
 *
 * Conserva la fila del viaje (auditoría/finanzas) y borra coordenadas precisas + ruta. Idempotente:
 * la anonimización es una sobre-escritura determinista, reprocesar el evento es un no-op.
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

interface UserDeletedPayload {
  userId: string;
  driverId?: string;
  at: string;
}

@Injectable()
export class UserDeletedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserDeletedConsumer.name);
  private readonly consumer: KafkaEventConsumer;

  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'trip-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: 'trip-service.erasure',
    });
    this.consumer = new KafkaEventConsumer(kafka, 'trip-service.erasure');
    this.consumer.on('user.deleted', (envelope) => this.onUserDeleted(envelope));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Suscrito a user.deleted (derecho al olvido)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('user.deleted');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('user.deleted con payload inválido; ignorado');
      return;
    }
    const { userId } = parsed.data as UserDeletedPayload;
    try {
      // El pasajero del viaje es el usuario borrado (passengerId === userId de identity).
      await this.trips.anonymizePassenger(userId);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; aquí solo registramos para diagnóstico.
      this.logger.error({ err, userId }, 'No se pudo anonimizar los viajes del usuario borrado');
      throw err;
    }
  }
}
