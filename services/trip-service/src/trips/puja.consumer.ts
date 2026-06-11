/**
 * PUJA (ADR 010 §4) · consumidor Kafka de los eventos de cierre de la negociación que dispatch
 * publica hacia trip:
 *
 *  - `dispatch.offer_accepted` {tripId, driverId, priceCents} → el pasajero eligió una oferta; el
 *    precio ACORDADO (que puede diferir del bid si fue un COUNTER) pasa a ser el `fareCents` del viaje.
 *    El ASSIGNED lo materializa el DispatchConsumer (dispatch.match_found); aquí SOLO se escribe el
 *    precio. dispatch emite ambos en la misma tx de outbox; como tocan campos disjuntos (precio vs
 *    estado/driver), el orden de llegada es indiferente.
 *  - `dispatch.no_offers` {tripId, reason} → la puja cerró sin match → el viaje pasa a EXPIRED
 *    (pantalla NoOffers; el pasajero re-puja). Subsume el viejo dispatch.timeout (#5).
 *
 * Idempotente: ambos handlers releen el viaje y aplican escrituras deterministas / guardadas por estado.
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

interface OfferAcceptedPayload {
  tripId: string;
  driverId: string;
  priceCents: number;
  /// H13 — ciclo de negociación que produjo esta aceptación (lo estampó dispatch desde el board).
  negotiationSeq: number;
}

interface NoOffersPayload {
  tripId: string;
  reason: string;
}

interface BidCancelledPayload {
  tripId: string;
  reason: string;
}

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'trip-service';

/** Group propio de la PUJA (no comparte el del match ni el de erasure). */
const PUJA_GROUP_ID = 'trip-service.puja';

@Injectable()
export class PujaConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: PUJA_GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'dispatch.offer_accepted': (envelope) => this.onOfferAccepted(envelope),
      'dispatch.no_offers': (envelope) => this.onNoOffers(envelope),
      // FIX puja-cancel: el pasajero canceló la PUJA → cierra el VIAJE (no solo el board). Mismo topic
      // `dispatch` (ya suscrito por offer_accepted/no_offers): agregar el handler NO abre una suscripción nueva.
      'dispatch.bid_cancelled': (envelope) => this.onBidCancelled(envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (PUJA)`;
  }

  private async onOfferAccepted(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('dispatch.offer_accepted');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('dispatch.offer_accepted con payload inválido; ignorado');
      return;
    }
    const { tripId, priceCents, negotiationSeq } = parsed.data as OfferAcceptedPayload;
    try {
      await this.trips.applyAgreedFare(tripId, priceCents, negotiationSeq);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; aquí solo registramos para diagnóstico.
      this.logger.error({ err, tripId }, 'No se pudo fijar el precio acordado del viaje');
      throw err;
    }
  }

  private async onNoOffers(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('dispatch.no_offers');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('dispatch.no_offers con payload inválido; ignorado');
      return;
    }
    const { tripId, reason } = parsed.data as NoOffersPayload;
    try {
      await this.trips.expireFromNoOffers(tripId, reason);
    } catch (err) {
      this.logger.error({ err, tripId }, 'No se pudo expirar el viaje sin ofertas');
      throw err;
    }
  }

  private async onBidCancelled(envelope: EventEnvelope<unknown>): Promise<void> {
    const schema = schemaForEvent('dispatch.bid_cancelled');
    const parsed = schema?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn('dispatch.bid_cancelled con payload inválido; ignorado');
      return;
    }
    const { tripId } = parsed.data as BidCancelledPayload;
    try {
      await this.trips.cancelFromBid(tripId);
    } catch (err) {
      this.logger.error({ err, tripId }, 'No se pudo cancelar el viaje por bid_cancelled');
      throw err;
    }
  }
}
