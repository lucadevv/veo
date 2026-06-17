import { describe, it, expect } from 'vitest';
import { DispatchScorer, type ScoreInput, type ScoringWeights } from './scoring';

const weights: ScoringWeights = { distance: 5000, rating: 1, idle: 10, cancel: 5 };
const NO_TRIP = 1_000_000_000;

describe('DispatchScorer · scoring de matching (BR-T06)', () => {
  const scorer = new DispatchScorer(weights);

  it('aplica la fórmula score = w1/dist + w2*rating + w3/idle - w4*cancel', () => {
    const input: ScoreInput = {
      driverId: 'A',
      distanceMeters: 500,
      avgRating: 4.8,
      secondsSinceLastTrip: NO_TRIP,
      cancellationRate: 0,
    };
    // 5000/500 + 1*4.8 + 10/1e9 - 0 = 10 + 4.8 ≈ 14.8
    expect(scorer.score(input)).toBeCloseTo(14.8, 4);
  });

  it('penaliza la tasa de cancelación y premia la cercanía', () => {
    const near: ScoreInput = {
      driverId: 'C',
      distanceMeters: 200,
      avgRating: 3.0,
      secondsSinceLastTrip: NO_TRIP,
      cancellationRate: 0.5,
    };
    // 5000/200 + 3 - 5*0.5 = 25 + 3 - 2.5 = 25.5
    expect(scorer.score(near)).toBeCloseTo(25.5, 4);
  });

  it('ordena los candidatos de mejor a peor score', () => {
    const inputs: ScoreInput[] = [
      {
        driverId: 'A',
        distanceMeters: 500,
        avgRating: 4.8,
        secondsSinceLastTrip: NO_TRIP,
        cancellationRate: 0,
      }, // 14.8
      {
        driverId: 'B',
        distanceMeters: 1000,
        avgRating: 5.0,
        secondsSinceLastTrip: NO_TRIP,
        cancellationRate: 0,
      }, // 10
      {
        driverId: 'C',
        distanceMeters: 200,
        avgRating: 3.0,
        secondsSinceLastTrip: NO_TRIP,
        cancellationRate: 0.5,
      }, // 25.5
    ];
    const ranked = scorer.rank(inputs);
    expect(ranked.map((r) => r.driverId)).toEqual(['C', 'A', 'B']);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it('premia la actividad reciente (idle pequeño aporta más)', () => {
    const recent = scorer.score({
      driverId: 'R',
      distanceMeters: 1000,
      avgRating: 5,
      secondsSinceLastTrip: 30,
      cancellationRate: 0,
    });
    const idleLong = scorer.score({
      driverId: 'L',
      distanceMeters: 1000,
      avgRating: 5,
      secondsSinceLastTrip: NO_TRIP,
      cancellationRate: 0,
    });
    expect(recent).toBeGreaterThan(idleLong);
  });

  it('evita división por cero con distancia 0', () => {
    const s = scorer.score({
      driverId: 'Z',
      distanceMeters: 0,
      avgRating: 5,
      secondsSinceLastTrip: NO_TRIP,
      cancellationRate: 0,
    });
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeCloseTo(5000 + 5, 4);
  });
});
