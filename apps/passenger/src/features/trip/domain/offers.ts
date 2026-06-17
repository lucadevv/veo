import type {OfferMadeMsg, OfferView} from '@veo/api-client';

/** Convierte una oferta EN VIVO (socket) al shape de OfferView; las ofertas en vivo están PENDING. */
function liveToView(msg: OfferMadeMsg): OfferView {
  return {
    tripId: msg.tripId,
    driverId: msg.driverId,
    kind: msg.kind,
    priceCents: msg.priceCents,
    etaSeconds: msg.etaSeconds,
    status: 'PENDING',
  };
}

/**
 * Fusiona el snapshot REST (`GET /trips/:id/offers`) con las ofertas EN VIVO (socket `offer:made`),
 * deduplicando por `driverId` (la versión en vivo gana, es más fresca). Ordena para que el pasajero
 * elija fácil: primero las que ACEPTAN su precio, luego por precio ascendente, luego por ETA. Pura.
 */
export function mergeOffers(
  rest: OfferView[],
  live: OfferMadeMsg[],
  withdrawn: readonly string[] = [],
): OfferView[] {
  // BE-3 · driverIds retirados (offer:withdrawn): se excluyen de AMBAS fuentes al instante (sin esperar
  // el refetch REST, que igual los dropea cuando pasan a STALE).
  const excluded = new Set(withdrawn);
  const byDriver = new Map<string, OfferView>();
  for (const o of rest)
    if (!excluded.has(o.driverId)) byDriver.set(o.driverId, o);
  for (const m of live) {
    if (excluded.has(m.driverId)) continue;
    const liveView = liveToView(m);
    const prev = byDriver.get(m.driverId);
    // El live gana en precio/kind/eta/status (es más fresco), PERO el offer:made llega SIN enriquecer
    // (BE-1: el consumer Kafka no enriquece). Preservamos nombre/rating/vehículo del REST si el live no
    // los trae, para que la card NO parpadee a "Conductor" genérico entre el live y el próximo refetch.
    byDriver.set(
      m.driverId,
      prev
        ? {
            ...liveView,
            driverName: liveView.driverName ?? prev.driverName,
            rating: liveView.rating ?? prev.rating,
            ratingCount: liveView.ratingCount ?? prev.ratingCount,
            vehicle: liveView.vehicle ?? prev.vehicle,
          }
        : liveView,
    );
  }
  return [...byDriver.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'ACCEPT_PRICE' ? -1 : 1;
    if (a.priceCents !== b.priceCents) return a.priceCents - b.priceCents;
    return a.etaSeconds - b.etaSeconds;
  });
}
