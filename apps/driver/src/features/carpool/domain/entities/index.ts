import type {
  BookingRequestList,
  BookingRequestView,
  PublishTripRequest,
  PublishedTripList,
  PublishedTripView,
  UpdateTripRequest,
} from '@veo/api-client';

/**
 * Entidades del dominio de carpooling (conductor). Son alias tipados sobre el contrato de
 * `@veo/api-client` (ADR-014): la fuente de verdad de la forma vive en el contrato compartido, acá
 * solo les damos nombre de dominio. Montos siempre en céntimos PEN (enteros).
 */

/** La OFERTA (viaje publicado) del conductor tal como la devuelve el servidor. */
export type PublishedTrip = PublishedTripView;
/** Página (keyset) de las ofertas del conductor autenticado. */
export type PublishedTrips = PublishedTripList;
/** Body para publicar una nueva oferta (`driverId` lo deriva el BFF de la identidad). */
export type PublishTripInput = PublishTripRequest;
/** Body PARCIAL para editar una oferta PUBLICADA (todos los campos opcionales). */
export type UpdateTripInput = UpdateTripRequest;

/** La SOLICITUD (reserva) entrante que el conductor VE sobre uno de sus viajes. */
export type BookingRequest = BookingRequestView;
/** Página (keyset) de las solicitudes de un viaje propio. */
export type BookingRequests = BookingRequestList;
