/**
 * EventsConsumer — suscriptor Kafka de share-service.
 *  - trip.started: actualiza el read-model del viaje (estado IN_PROGRESS).
 *  - panic.triggered (BR-S05): activa automáticamente enlaces de seguimiento para los contactos de
 *    confianza verificados del pasajero, publica share.link_generated (outbox) y envía el SMS con el
 *    enlace por el puerto SMS (el evento no transporta el token, ver docs/events.md).
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + log de suscripción derivado del
 * registro) vive promovido en KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId
 * = UN consumer con TODOS sus eventos en `handlers()`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EventEnvelope, type EventHandler, type EventPayload } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { isDomainError } from '@veo/utils';
import { ShareService } from '../share/share.service';
import { ContactsService } from '../contacts/contacts.service';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'share-service';

@Injectable()
export class EventsConsumer extends KafkaConsumerBootstrap {
  private readonly panicLinkTtlSeconds: number;
  private readonly panicLinkMaxUses: number;

  constructor(
    private readonly share: ShareService,
    private readonly contacts: ContactsService,
    private readonly snapshots: TripSnapshotService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: config.getOrThrow<string>('KAFKA_CONSUMER_GROUP'),
    });
    // Enlaces de pánico viven más que un share normal y admiten muchas aperturas.
    this.panicLinkTtlSeconds = config.getOrThrow<number>('SHARE_LINK_TTL_SECONDS');
    this.panicLinkMaxUses = config.getOrThrow<number>('SHARE_LINK_MAX_USES');
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'trip.started': (env) => this.handleTripStarted(env),
      'panic.triggered': (env) => this.handlePanic(env),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Consumidor Kafka iniciado (${eventTypes.join(', ')})`;
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
