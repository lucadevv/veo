/**
 * Puerto de entrega de ofertas al conductor. Cuando el matching ofrece un viaje a un conductor,
 * además de persistir la fila OFFERED (que driver-bff/trip consultan por gRPC), se notifica al
 * dispositivo del conductor a través de esta abstracción.
 *
 * La implementación de producción (`RealtimeOfferDelivery`) publica `dispatch.offered` por el
 * outbox (topic `dispatch`); driver-bff lo consume y lo reemite por Socket.IO (`dispatch:offer`)
 * al conductor destino. La fila OFFERED sigue siendo la fuente de verdad para las lecturas gRPC.
 */
export const OFFER_DELIVERY = Symbol('OFFER_DELIVERY');

export interface DispatchOffer {
  matchId: string;
  tripId: string;
  driverId: string;
  etaSeconds: number;
  attempt: number;
  score: number;
  surgeMultiplier: number;
  /** ISO-8601: límite para responder la oferta (offeredAt + DISPATCH_OFFER_TIMEOUT_MS). */
  expiresAt: string;
}

export interface OfferDelivery {
  deliver(offer: DispatchOffer): void | Promise<void>;
}
