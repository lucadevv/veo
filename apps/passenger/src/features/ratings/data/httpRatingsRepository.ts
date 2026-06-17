import {
  type HttpClient,
  type MyRatingView,
  myRatingView,
  type RatingAggregateView,
  ratingAggregateView,
  type RatingSubmitRequest,
  type RatingView,
  ratingView,
} from '@veo/api-client';
import type {RatingsRepository} from '../domain/ratingsRepository';

/** Implementación de `RatingsRepository` contra el public-bff. */
export class HttpRatingsRepository implements RatingsRepository {
  constructor(private readonly http: HttpClient) {}

  submit(input: RatingSubmitRequest): Promise<RatingView> {
    return this.http.post('/ratings', {body: input, schema: ratingView});
  }

  getAggregate(subjectId: string): Promise<RatingAggregateView> {
    return this.http.get(`/ratings/aggregate/${subjectId}`, {
      schema: ratingAggregateView,
    });
  }

  async getMyRatingForTrip(tripId: string): Promise<MyRatingView | null> {
    // Contrato soberano `@veo/api-client`: GET /ratings?tripId → 200 + myRatingView (ya calificó) o
    // 204 → undefined (el HttpClient mapea No Content a undefined). Lo normalizamos a `null`.
    const result = await this.http.get<MyRatingView | undefined>('/ratings', {
      query: {tripId},
      schema: myRatingView,
    });
    return result ?? null;
  }
}
