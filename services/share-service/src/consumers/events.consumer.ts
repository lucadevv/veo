/**
 * EventsConsumer — suscriptor Kafka de share-service.
 *  - trip.started: actualiza el read-model del viaje (estado IN_PROGRESS).
 *  - panic.triggered (BR-S05): activa automáticamente enlaces de seguimiento para los contactos de
 *    confianza verificados del pasajero, publica share.link_generated (outbox) y envía el SMS con el
 *    enlace por el puerto SMS (el evento no transporta el token, ver docs/events.md).
 */
import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  type EventEnvelope,
  type EventPayload,
} from '@veo/events';
import { isDomainError } from '@veo/utils';
import { ShareService } from '../share/share.service';
import { ContactsService } from '../contacts/contacts.service';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import type { Env } from '../config/env.schema';

@Injectable()
export class EventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsConsumer.name);
  private readonly consumer: KafkaEventConsumer;
  private readonly panicLinkTtlSeconds: number;
  private readonly panicLinkMaxUses: number;

  constructor(
    private readonly share: ShareService,
    private readonly contacts: ContactsService,
    private readonly snapshots: TripSnapshotService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'share-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: config.getOrThrow<string>('KAFKA_CONSUMER_GROUP'),
    });
    this.consumer = new KafkaEventConsumer(kafka, config.getOrThrow<string>('KAFKA_CONSUMER_GROUP'));
    // Enlaces de pánico viven más que un share normal y admiten muchas aperturas.
    this.panicLinkTtlSeconds = config.getOrThrow<number>('SHARE_LINK_TTL_SECONDS');
    this.panicLinkMaxUses = config.getOrThrow<number>('SHARE_LINK_MAX_USES');

    this.consumer
      .on('trip.started', (env) => this.handleTripStarted(env))
      .on('panic.triggered', (env) => this.handlePanic(env));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
    this.logger.log('Consumidor Kafka iniciado (trip.started, panic.triggered)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }

  private async handleTripStarted(envelope: EventEnvelope<unknown>): Promise<void> {
    const p = envelope.payload as EventPayload<'trip.started'>;
    await this.snapshots.onTripStarted(p.tripId, p.driverId, new Date(p.startedAt), p.passengerId);
  }

  private async handlePanic(envelope: EventEnvelope<unknown>): Promise<void> {
    const p = envelope.payload as EventPayload<'panic.triggered'>;
    await this.snapshots.onPanic(p.tripId, p.passengerId, p.geo, new Date(p.triggeredAt));

    const verified = await this.contacts.listVerified(p.passengerId);
    if (verified.length === 0) {
      this.logger.warn(`Pánico ${p.panicId}: el pasajero ${p.passengerId} no tiene contactos verificados`);
      return;
    }

    for (const contact of verified) {
      try {
        const link = await this.share.createLinkInternal(p.tripId, {
          contactId: contact.id,
          ttlSeconds: this.panicLinkTtlSeconds,
          maxUses: this.panicLinkMaxUses,
          // Idempotencia por (pánico, contacto): una redelivery Kafka reutiliza el enlace y NO reenvía SMS.
          dedupKey: `panic:${p.panicId}:${contact.id}`,
        });
        // Si el enlace ya existía (redelivery), no hay token nuevo que mandar: evitamos SMS duplicado.
        if (link.deduped) {
          this.logger.debug(`Pánico ${p.panicId}: enlace ya existente para contacto ${contact.id}, SMS omitido`);
          continue;
        }
        await this.sms.send(
          contact.phone,
          `ALERTA VEO: ${contact.name}, sigue en tiempo real el viaje de tu contacto aquí: ${link.url}`,
        );
      } catch (err) {
        const msg = isDomainError(err) ? err.message : String(err);
        this.logger.error(`No se pudo generar/enviar el enlace de pánico al contacto ${contact.id}: ${msg}`);
      }
    }
  }
}
