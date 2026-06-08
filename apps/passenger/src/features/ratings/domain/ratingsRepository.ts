import type {
  MyRatingView,
  RatingAggregateView,
  RatingSubmitRequest,
  RatingView,
} from '@veo/api-client';

/** Abstracción del repositorio de Calificaciones (DIP). */
export interface RatingsRepository {
  /** POST /ratings → envía la calificación de un viaje. */
  submit(input: RatingSubmitRequest): Promise<RatingView>;
  /** GET /ratings/aggregate/:subjectId → agregado rolling 30d. */
  getAggregate(subjectId: string): Promise<RatingAggregateView>;
  /**
   * GET /ratings?tripId → MI calificación de un viaje (la que ESTE pasajero le dio al conductor), o
   * `null` si todavía no califiqué (el bff responde 204). Filtrada server-side por el rater autenticado
   * (anti-IDOR). Habilita el indicador "ya calificaste" del historial y el estado de solo-lectura del
   * detalle, sin depender del 409 de un POST especulativo.
   */
  getMyRatingForTrip(tripId: string): Promise<MyRatingView | null>;
}
