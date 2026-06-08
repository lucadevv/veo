/**
 * Entrega de oferta en producción. La fila `dispatch_matches` en estado OFFERED sigue siendo la
 * fuente de verdad para las lecturas gRPC; además aquí se publica `dispatch.offered` DIRECTO a Kafka
 * (B3, fire-and-forget): NO por el outbox. `dispatch.offered` es un ping EFÍMERO ("hay un bid al que
 * podés responder"), backstopped por el poll del conductor a `/bids/open`, así que no merece la
 * durabilidad del outbox transaccional (un board a N conductores escribía N filas durables en Postgres
 * por un ping descartable). El relay/outbox queda SOLO para los durables (`match_found`/`offer_accepted`/
 * `no_offers`). driver-bff consume `dispatch.offered` del MISMO topic `dispatch` de Kafka → INALTERADO.
 *
 * Idempotencia: `dedupKey = matchId` (cada intento de oferta es un match único), así que reintentar
 * la publicación es seguro y nunca genera dos ofertas distintas para el mismo match.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { domainEventsTotal } from '@veo/observability';
import { type DispatchOffer, type OfferDelivery } from './offer-delivery.port';
import { EPHEMERAL_EVENT_PUBLISHER, type EphemeralEventPublisher } from './ephemeral-event.port';

@Injectable()
export class RealtimeOfferDelivery implements OfferDelivery {
  private readonly logger = new Logger(RealtimeOfferDelivery.name);

  constructor(
    @Inject(EPHEMERAL_EVENT_PUBLISHER) private readonly publisher: EphemeralEventPublisher,
  ) {}

  async deliver(offer: DispatchOffer): Promise<void> {
    const envelope = createEnvelope({
      eventType: 'dispatch.offered',
      producer: 'dispatch-service',
      payload: {
        tripId: offer.tripId,
        driverId: offer.driverId,
        matchId: offer.matchId,
        expiresAt: offer.expiresAt,
      },
      dedupKey: offer.matchId,
    });

    // B3 — publicación DIRECTA al topic `dispatch` de Kafka (sin fila en el outbox de Postgres). Se
    // clavea por tripId (entidad raíz del dominio dispatch), igual que el resto de eventos dispatch.
    await this.publisher.publish(envelope, offer.tripId);

    this.logger.debug(
      `oferta ${offer.matchId} → driver ${offer.driverId} (trip ${offer.tripId}, intento ${offer.attempt}, eta ${offer.etaSeconds}s) publicada (Kafka directo)`,
    );
    domainEventsTotal.inc({ event: 'dispatch.offered', result: 'published' });
  }
}
