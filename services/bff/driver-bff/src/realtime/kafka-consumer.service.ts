/**
 * Consumidor Kafka del driver-bff. Suscrito a los topics `dispatch` y `trip`; por cada evento
 * relevante resuelve el conductor destino y lo empuja a su sala Socket.IO.
 * Los payloads se validan con EVENT_SCHEMAS de @veo/events antes de emitir.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  EVENT_SCHEMAS,
  chatMessageSent,
  type EventEnvelope,
} from '@veo/events';
import { createLogger, domainEventsTotal, type Logger } from '@veo/observability';
import type { ChatMessage } from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import type { TripReply } from '../common/grpc-replies';
import { SYSTEM_IDENTITY } from '../common/identities';
import { DriverGateway } from './driver.gateway';
import type { Env } from '../config/env.schema';

/** Eventos de la máquina de estados del viaje que interesan al conductor. */
const TRIP_EVENTS = [
  'trip.assigned',
  'trip.accepted',
  'trip.arriving',
  'trip.arrived',
  'trip.started',
  'trip.completed',
  'trip.cancelled',
] as const;

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private consumer?: KafkaEventConsumer;
  private readonly logger: Logger;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly gateway: DriverGateway,
    private readonly grpc: GrpcGateway,
  ) {
    this.logger = createLogger('driver-bff-kafka');
  }

  async onModuleInit(): Promise<void> {
    const brokers = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',').map((b) => b.trim());
    const kafka = createKafka({ clientId: 'driver-bff', brokers });
    const consumer = new KafkaEventConsumer(kafka, this.config.getOrThrow<string>('KAFKA_GROUP_ID'));

    consumer.on('dispatch.offered', (env) => this.handleEvent(env, 'dispatch:offer'));
    consumer.on('dispatch.match_found', (env) => this.handleEvent(env, 'dispatch:match'));
    for (const type of TRIP_EVENTS) {
      consumer.on(type, (env) => this.handleEvent(env, 'trip:update'));
    }
    consumer.on('chat.message_sent', (env) => this.handleChatMessage(env));

    this.consumer = consumer;
    await consumer.start();
    this.logger.info('consumidor Kafka driver-bff iniciado (topics dispatch, trip)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.consumer) await this.consumer.stop();
  }

  /** Valida el payload, resuelve el conductor y emite a su sala. */
  private async handleEvent(envelope: EventEnvelope<unknown>, socketEvent: string): Promise<void> {
    const schema = EVENT_SCHEMAS[envelope.eventType as keyof typeof EVENT_SCHEMAS];
    if (!schema) return;
    const parsed = schema.safeParse(envelope.payload);
    if (!parsed.success) {
      domainEventsTotal.inc({ event: envelope.eventType, result: 'invalid' });
      return;
    }
    const payload = parsed.data as Record<string, unknown>;

    try {
      const driverId = await this.resolveDriverId(payload);
      if (!driverId) {
        domainEventsTotal.inc({ event: envelope.eventType, result: 'no_driver' });
        return;
      }
      this.gateway.emitToDriver(driverId, socketEvent, {
        eventType: envelope.eventType,
        occurredAt: envelope.occurredAt,
        payload: parsed.data,
      });
      domainEventsTotal.inc({ event: envelope.eventType, result: 'emitted' });
    } catch (err) {
      this.logger.warn({ err, eventType: envelope.eventType }, 'no se pudo enrutar el evento al conductor');
      domainEventsTotal.inc({ event: envelope.eventType, result: 'error' });
    }
  }

  /**
   * Mensaje de chat (Ola 2A): resuelve el conductor del viaje y le emite `chat:message` con el
   * mensaje plano (ChatMessage). El conductor recibe así los mensajes del pasajero en tiempo real.
   */
  private async handleChatMessage(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = chatMessageSent.safeParse(envelope.payload);
    if (!parsed.success) {
      domainEventsTotal.inc({ event: 'chat.message_sent', result: 'invalid' });
      return;
    }
    try {
      const trip = await this.grpc.call<TripReply>(
        'trip',
        'GetTrip',
        { id: parsed.data.tripId },
        SYSTEM_IDENTITY,
      );
      if (!trip.found || !trip.driverId) {
        domainEventsTotal.inc({ event: 'chat.message_sent', result: 'no_driver' });
        return;
      }
      const msg: ChatMessage = {
        id: parsed.data.messageId,
        tripId: parsed.data.tripId,
        senderId: parsed.data.senderId,
        senderRole: parsed.data.senderRole,
        body: parsed.data.body,
        createdAt: parsed.data.createdAt,
      };
      this.gateway.emitToDriver(trip.driverId, 'chat:message', msg);
      domainEventsTotal.inc({ event: 'chat.message_sent', result: 'emitted' });
    } catch (err) {
      this.logger.warn({ err }, 'no se pudo enrutar el mensaje de chat al conductor');
      domainEventsTotal.inc({ event: 'chat.message_sent', result: 'error' });
    }
  }

  /** driverId del payload si viene; si no (p.ej. trip.cancelled), se lee del viaje por gRPC. */
  private async resolveDriverId(payload: Record<string, unknown>): Promise<string | undefined> {
    const direct = payload.driverId;
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const tripId = payload.tripId;
    if (typeof tripId !== 'string' || tripId.length === 0) return undefined;
    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id: tripId }, SYSTEM_IDENTITY);
    return trip.found && trip.driverId ? trip.driverId : undefined;
  }
}
