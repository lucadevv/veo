import type {BiddingRepository} from '../repositories/bidding-repository';
import type {OpenBid, SubmittedOffer} from '../entities';
import {OfferKind, assertValidCounter} from '../value-objects/offer-kind';

/** Caso de uso: listar las pujas OPEN cercanas que el conductor puede ofertar. */
export class ListOpenBidsUseCase {
  constructor(private readonly bidding: BiddingRepository) {}
  execute(): Promise<OpenBid[]> {
    return this.bidding.listOpenBids();
  }
}

/**
 * Caso de uso: ACEPTAR el precio del bid tal cual. El precio enviado es EXACTAMENTE `bid.bidCents` (el
 * gate de dispatch exige ACCEPT_PRICE === bidCents): no hay ambigüedad ni input del usuario que validar.
 */
export class AcceptBidUseCase {
  constructor(private readonly bidding: BiddingRepository) {}
  execute(bid: OpenBid): Promise<SubmittedOffer> {
    return this.bidding.submitOffer(bid.tripId, {
      kind: OfferKind.ACCEPT_PRICE,
      priceCents: bid.bidCents,
    });
  }
}

/**
 * Caso de uso: CONTRAOFERTAR un precio mayor al bid. Valida en el cliente que el precio sea
 * (bid, techo] ANTES de pegarle al backend (fail-fast; el gate autoritativo sigue en dispatch). Lanza
 * `InvalidCounterOfferError` si está fuera de rango.
 */
export class CounterBidUseCase {
  constructor(private readonly bidding: BiddingRepository) {}
  execute(bid: OpenBid, priceCents: number): Promise<SubmittedOffer> {
    assertValidCounter(priceCents, bid.bidCents);
    return this.bidding.submitOffer(bid.tripId, {
      kind: OfferKind.COUNTER,
      priceCents,
    });
  }
}
