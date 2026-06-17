import type { OpenBidView, SubmitOfferRequest, SubmittedOfferView } from '@veo/api-client';

/**
 * Entidades del dominio de PUJAS (lado conductor, ADR 010 §6).
 *
 * El conductor ve las pujas OPEN cercanas que PUEDE ofertar (marketplace "proponé tu precio") y responde
 * aceptando el precio o contraofertando uno mayor. Las pujas llegan por dos vías: el poll REST `GET /bids`
 * y el ping enriquecido `dispatch:offer` (mismo shape `OpenBid`). El submit se confirma por REST.
 */

/** Una puja OPEN cercana que el conductor elegible puede ofertar. */
export type OpenBid = OpenBidView;

/** La oferta/contraoferta que el conductor acaba de enviar (estado PENDING). */
export type SubmittedOffer = SubmittedOfferView;

/** Cuerpo del submit: tipo de respuesta + precio en céntimos PEN. */
export type SubmitOfferInput = SubmitOfferRequest;
