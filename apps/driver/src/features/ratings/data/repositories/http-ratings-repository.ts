import type { HttpClient } from '@veo/api-client';
import {
  type MyRatingView,
  myRatingView,
  type RatingSubmitRequest,
  type RatingView,
  ratingView,
} from '@veo/api-client';
import type { RatingsRepository } from '../../domain';

/** Implementación HTTP del `RatingsRepository` contra el driver-bff. */
export class HttpRatingsRepository implements RatingsRepository {
  constructor(private readonly http: HttpClient) {}

  rate(input: RatingSubmitRequest): Promise<RatingView> {
    return this.http.post('/ratings', { body: input, schema: ratingView });
  }

  async getMyTripRating(tripId: string): Promise<MyRatingView | null> {
    // GET /ratings?tripId → 200 + myRatingView (ya calificó) o 204 → undefined (el HttpClient mapea No
    // Content a undefined). Lo normalizamos a `null`: "sin rating tuyo" NO es error, es el estado normal.
    const result = (await this.http.get('/ratings', {
      query: { tripId },
      schema: myRatingView,
    })) as MyRatingView | undefined;
    return result ?? null;
  }
}
