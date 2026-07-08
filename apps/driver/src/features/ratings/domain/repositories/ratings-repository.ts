import type { MyRatingView, RatingSubmitRequest, RatingView } from '../entities';

/**
 * Contrato del repositorio de calificaciones (capa domain). Implementación concreta en `data/`.
 * El `raterId` NUNCA viaja del cliente: lo deriva el driver-bff/rating-service de la identidad (anti-IDOR).
 */
export interface RatingsRepository {
  /** POST /ratings — envía la calificación del conductor al pasajero de un viaje completado. */
  rate(input: RatingSubmitRequest): Promise<RatingView>;
  /**
   * GET /ratings?tripId — MI calificación de un viaje (la que ESTE conductor le dio al pasajero), o
   * `null` si aún no calificó (el BFF responde 204). Filtrada server-side por el rater autenticado.
   */
  getMyTripRating(tripId: string): Promise<MyRatingView | null>;
}
