import type {
  MyRatingView,
  RatingAggregateView,
  RatingSubmitRequest,
  RatingView,
} from '@veo/api-client';
import type {RatingsRepository} from '../src/features/ratings/domain/ratingsRepository';
import {
  RatingValidationError,
  SubmitRatingUseCase,
} from '../src/features/ratings/domain/usecases';

class FakeRatingsRepository implements RatingsRepository {
  submit = jest.fn(
    async (input: RatingSubmitRequest): Promise<RatingView> => ({
      id: 'r-1',
      tripId: input.tripId,
      raterId: 'pax',
      ratedId: input.ratedId,
      stars: input.stars,
      comment: input.comment ?? null,
      createdAt: '2026-05-29T10:00:00.000Z',
    }),
  );
  getAggregate = jest.fn(
    async (): Promise<RatingAggregateView> => ({}) as RatingAggregateView,
  );
  getMyRatingForTrip = jest.fn(async (): Promise<MyRatingView | null> => null);
}

const base: RatingSubmitRequest = {
  tripId: '11111111-1111-1111-1111-111111111111',
  ratedId: '22222222-2222-2222-2222-222222222222',
  ratedRole: 'DRIVER',
  stars: 5,
};

describe('SubmitRatingUseCase', () => {
  it('envía la calificación válida', async () => {
    const repo = new FakeRatingsRepository();
    const useCase = new SubmitRatingUseCase(repo);

    const result = await useCase.execute(base);

    expect(repo.submit).toHaveBeenCalledTimes(1);
    expect(result.stars).toBe(5);
  });

  it('rechaza estrellas fuera de rango (1-5)', () => {
    const repo = new FakeRatingsRepository();
    const useCase = new SubmitRatingUseCase(repo);

    expect(() => useCase.execute({...base, stars: 0})).toThrow(
      RatingValidationError,
    );
    expect(() => useCase.execute({...base, stars: 6})).toThrow(
      RatingValidationError,
    );
    expect(repo.submit).not.toHaveBeenCalled();
  });
});
