import type { MyRatingView, RatePassengerInput, RatingView } from '../entities';
import type { RatingsRepository } from '../repositories/ratings-repository';

/** Error de validación de calificación (fuera de 1..5). */
export class RatingValidationError extends Error {
  constructor() {
    super('La calificación debe estar entre 1 y 5 estrellas');
    this.name = 'RatingValidationError';
  }
}

/**
 * Caso de uso: el conductor califica al PASAJERO al cerrar el viaje (POST /ratings). Fija `ratedRole`
 * a 'PASSENGER' (regla de negocio del lado conductor — la presentación no puede equivocarlo) y valida
 * las estrellas antes de pegarle al backend. El `ratedId` es el `passengerId` del viaje.
 */
export class RatePassengerUseCase {
  constructor(private readonly repository: RatingsRepository) {}

  execute(input: RatePassengerInput): Promise<RatingView> {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw new RatingValidationError();
    }
    return this.repository.rate({
      tripId: input.tripId,
      ratedId: input.passengerId,
      ratedRole: 'PASSENGER',
      stars: input.stars,
      ...(input.comment && input.comment.trim() ? { comment: input.comment.trim() } : {}),
    });
  }
}

/** Caso de uso: MI calificación de un viaje (para saber si ya califiqué / re-entrada). `null` si aún no. */
export class GetMyTripRatingUseCase {
  constructor(private readonly repository: RatingsRepository) {}

  execute(tripId: string): Promise<MyRatingView | null> {
    return this.repository.getMyTripRating(tripId);
  }
}
