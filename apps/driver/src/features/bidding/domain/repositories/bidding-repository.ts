import type { OpenBid, SubmitOfferInput, SubmittedOffer } from '../entities';

/**
 * Contrato del repositorio de PUJAS (capa domain). Implementación concreta en `data/`.
 * El `driverId` NUNCA viaja del cliente: lo deriva el driver-bff de la identidad autenticada (anti-IDOR);
 * la elegibilidad (online + biométrico + !suspendido + vehículo) se enforce downstream en dispatch.
 */
export interface BiddingRepository {
  /** GET /bids — pujas OPEN cercanas que el conductor elegible puede ofertar. */
  listOpenBids(): Promise<OpenBid[]>;
  /** POST /bids/:tripId/offer — envía oferta (ACCEPT_PRICE) o contraoferta (COUNTER). */
  submitOffer(tripId: string, input: SubmitOfferInput): Promise<SubmittedOffer>;
}
