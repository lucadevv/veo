import type {RatingSubmitRequest, RatingView} from '@veo/api-client';
import type {RatingsRepository} from './ratingsRepository';

/** Error de validación de calificación. */
export class RatingValidationError extends Error {
  constructor() {
    super('La calificación debe estar entre 1 y 5 estrellas');
    this.name = 'RatingValidationError';
  }
}

/** Envía la calificación del conductor al terminar el viaje (POST /ratings). */
export class SubmitRatingUseCase {
  constructor(private readonly repository: RatingsRepository) {}

  execute(input: RatingSubmitRequest): Promise<RatingView> {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw new RatingValidationError();
    }
    return this.repository.submit(input);
  }
}
