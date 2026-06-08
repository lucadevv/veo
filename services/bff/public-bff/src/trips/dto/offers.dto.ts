import { ApiProperty } from '@nestjs/swagger';

/**
 * Vista de una oferta de un conductor sobre el board del viaje del pasajero (lado pasajero).
 * El pasajero ve estas ofertas para elegir UNA (ADR 010 §3.3). BE-1: el BFF la ENRIQUECE con rating +
 * vehículo del conductor (gRPC a rating/fleet, Path B) para que el pasajero elija por rating/vehículo.
 */
export interface OfferView {
  tripId: string;
  driverId: string;
  kind: string;
  priceCents: number;
  etaSeconds: number;
  status: string;
  /**
   * BE-1 · enriquecido por el BFF en `listOffers` (gRPC a identity/rating/fleet). OPCIONAL: el `accept`
   * devuelve la oferta cruda de dispatch (sin enriquecer) y NO renderiza card; el contrato mobile los
   * tiene optional+nullable. Null = downstream no disponible.
   */
  driverName?: string | null;
  rating?: number | null;
  ratingCount?: number;
  vehicle?: { make: string; model: string; color: string; plate: string } | null;
}

/** Estado del board del lado del pasajero. 'GONE' = la key ya no existe en Redis (expiró por TTL). */
export type ClientBoardStatus = 'OPEN' | 'CANCELLED' | 'EXPIRED' | 'CLOSED_MATCHED' | 'GONE';

/**
 * FIX contrato — respuesta de `GET /trips/:id/offers` (proxy de dispatch `GET /bids/:tripId/offers`): el
 * ESTADO del board + las ofertas ENRIQUECIDAS. Antes el endpoint devolvía solo `OfferView[]`; ahora el
 * cliente distingue una puja OPEN-sin-ofertas de una CANCELLED/EXPIRED/CLOSED_MATCHED/GONE sin adivinar por
 * un array vacío. `offers` sólo trae PENDING con board OPEN; en cualquier otro estado va [] (no zombies).
 */
export interface OffersBoardView {
  status: ClientBoardStatus;
  /** epoch(ms) de vencimiento de la ventana; null si el board ya no existe (GONE). */
  expiresAt: number | null;
}

export interface OffersResponse {
  board: OffersBoardView;
  offers: OfferView[];
}

/** Respuesta de la cancelación del board. */
export class CancelBidResponse {
  @ApiProperty({ example: true })
  ok!: true;
}
