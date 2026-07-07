import {
  type MyRatingView,
  type RatingAggregateView,
  ratingAggregateView,
  type RatingSubmitRequest,
  type RatingView,
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

/**
 * Contrato soberano del PASAJERO vs respuesta real del public-bff (anti contract-break).
 *
 * El public-bff strippeó `flagged`/`flagReason` del `AggregateView` (moderación = fuga IDOR, cerrada
 * server-side). El `parse()` estricto del HttpClient corre `ratingAggregateView.parse(data)`: si el zod
 * soberano AÚN exigiera esos campos, la respuesta strippeada lanzaría ZodError y `getAggregate` del
 * pasajero crashearía en runtime. Estos tests anclan que el zod espeja EXACTO lo que el bff devuelve.
 */
describe('ratingAggregateView (contrato soberano del pasajero)', () => {
  // Lo que el public-bff `AggregateView` devuelve HOY (sin campos de moderación).
  const bffAggregateResponse = {
    subjectId: '22222222-2222-2222-2222-222222222222',
    role: 'DRIVER',
    rollingAvg30d: 4.7,
    count30d: 31,
    lastComputedAt: '2026-05-29T10:00:00.000Z',
  };

  it('parsea la respuesta del public-bff SIN flags de moderación (no lanza ZodError)', () => {
    expect(() => ratingAggregateView.parse(bffAggregateResponse)).not.toThrow();

    const parsed = ratingAggregateView.parse(bffAggregateResponse);
    expect(parsed.rollingAvg30d).toBe(4.7);
    expect(parsed.count30d).toBe(31);
  });

  it('tolera lastComputedAt null (agregado aún no computado)', () => {
    expect(() =>
      ratingAggregateView.parse({
        ...bffAggregateResponse,
        lastComputedAt: null,
      }),
    ).not.toThrow();
  });

  it('no declara campos de moderación en el contrato del pasajero (cierre IDOR)', () => {
    const parsed = ratingAggregateView.parse(bffAggregateResponse);
    expect(parsed).not.toHaveProperty('flagged');
    expect(parsed).not.toHaveProperty('flagReason');
    // El strip es a nivel de schema: un payload con flags NO los propaga al objeto parseado.
    const withFlags = ratingAggregateView.parse({
      ...bffAggregateResponse,
      flagged: true,
      flagReason: 'whatever',
    });
    expect(withFlags).not.toHaveProperty('flagged');
    expect(withFlags).not.toHaveProperty('flagReason');
  });
});
