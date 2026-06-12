/**
 * EventsConsumer — suscriptor Kafka de share-service.
 *  - trip.started: actualiza el read-model del viaje (estado IN_PROGRESS).
 *  - panic.triggered (BR-S05): crea EL enlace de seguimiento del viaje y DELEGA el fan-out durable de
 *    SMS a notification-service emitiendo `panic.fanout_requested` (outbox, en la misma transacción).
 *    El SMS YA NO se manda inline desde acá: el envío inline tragaba el fallo del proveedor y Kafka
 *    ACKeaba → el SMS se perdía para siempre (en redelivery el enlace deduped lo omitía). Ahora el
 *    engine durable de notification (retry/backoff/SMPP) garantiza el envío. notification resuelve los
 *    teléfonos por gRPC GetTrustedContacts; el evento lleva SOLO IDs + deep-link (CERO PII, §0.7).
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + log de suscripción derivado del
 * registro) vive promovido en KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId
 * = UN consumer con TODOS sus eventos en `handlers()`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EventEnvelope, type EventHandler, type EventPayload } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import { isDomainError } from '@veo/utils';
import { ShareService } from '../share/share.service';
import { ContactsService } from '../contacts/contacts.service';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'share-service';

/** BR-S05: máximo de contactos de confianza notificados por pánico. */
const MAX_TRUSTED_CONTACTS = 4;

@Injectable()
export class EventsConsumer extends KafkaConsumerBootstrap {
  private readonly panicLinkTtlSeconds: number;
  private readonly panicLinkMaxUses: number;

  constructor(
    private readonly share: ShareService,
    private readonly contacts: ContactsService,
    private readonly snapshots: TripSnapshotService,
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

    // SOLO IDs (sin teléfono/nombre): notification los resuelve por gRPC. Cap BR-S05.
    const contactIds = verified.slice(0, MAX_TRUSTED_CONTACTS).map((c) => c.id);

    try {
      // Crea EL enlace del viaje y, en la misma transacción, encola panic.fanout_requested (outbox).
      // notification-service hace el envío durable (retry/backoff). NADA de SMS inline acá.
      const result = await this.share.createPanicFanout(
        p.tripId,
        { panicId: p.panicId, passengerId: p.passengerId, geo: p.geo, contactIds },
        { ttlSeconds: this.panicLinkTtlSeconds, maxUses: this.panicLinkMaxUses },
      );
      if (result.emitted) {
        this.logger.log(`Pánico ${p.panicId}: fan-out delegado a notification (${contactIds.length} contactos)`);
      } else {
        this.logger.debug(`Pánico ${p.panicId}: enlace/fan-out ya existían (redelivery), no se re-delega`);
      }
    } catch (err) {
      // El catch cubre SOLO la creación del enlace + encolado del evento (transacción). Si falla, NO
      // ACKeamos a ciegas: relanzamos para que Kafka reintente (la idempotencia por dedupKey del enlace
      // evita duplicar). El SMS ya no vive acá, así que un fallo del proveedor no puede perderse.
      const msg = isDomainError(err) ? err.message : String(err);
      this.logger.error(`Pánico ${p.panicId}: no se pudo crear el enlace ni delegar el fan-out: ${msg}`);
      throw err;
    }
  }
}
