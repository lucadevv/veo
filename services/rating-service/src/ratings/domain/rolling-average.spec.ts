import { describe, it, expect } from 'vitest';
import {
  averageOfStars,
  computeRollingAverage,
  windowCutoff,
  type TimedRating,
} from './rolling-average';

describe('averageOfStars', () => {
  it('promedia y redondea a 2 decimales', () => {
    expect(averageOfStars([5, 4, 4])).toEqual({ avg: 4.33, count: 3 });
  });

  it('lista vacía → avg 0, count 0', () => {
    expect(averageOfStars([])).toEqual({ avg: 0, count: 0 });
  });

  it('redondeo bancario evita errores binarios (4.005 → 4.01)', () => {
    // suma 16.02 / 4 = 4.005 → 4.01
    expect(averageOfStars([4.01, 4, 4, 4.01])).toEqual({ avg: 4.01, count: 4 });
  });

  it('todos 5 → 5.00', () => {
    expect(averageOfStars([5, 5, 5])).toEqual({ avg: 5, count: 3 });
  });
});

describe('windowCutoff', () => {
  it('resta exactamente N días', () => {
    const now = new Date('2026-05-28T00:00:00.000Z');
    expect(windowCutoff(30, now).toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });
});

describe('computeRollingAverage · ventana 30 días', () => {
  const now = new Date('2026-05-28T12:00:00.000Z');
  const daysAgo = (d: number): Date => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  it('solo cuenta calificaciones dentro de la ventana', () => {
    const ratings: TimedRating[] = [
      { stars: 5, createdAt: daysAgo(1) }, // dentro
      { stars: 5, createdAt: daysAgo(29) }, // dentro
      { stars: 1, createdAt: daysAgo(31) }, // FUERA (no debe contar)
    ];
    expect(computeRollingAverage(ratings, 30, now)).toEqual({ avg: 5, count: 2 });
  });

  it('una calificación que sale de la ventana cambia el promedio', () => {
    const ratings: TimedRating[] = [
      { stars: 5, createdAt: daysAgo(10) },
      { stars: 1, createdAt: daysAgo(40) }, // fuera
    ];
    expect(computeRollingAverage(ratings, 30, now)).toEqual({ avg: 5, count: 1 });
  });

  it('borde exacto: createdAt == cutoff entra en la ventana', () => {
    const ratings: TimedRating[] = [{ stars: 3, createdAt: windowCutoff(30, now) }];
    expect(computeRollingAverage(ratings, 30, now)).toEqual({ avg: 3, count: 1 });
  });

  it('sin calificaciones en ventana → avg 0, count 0', () => {
    const ratings: TimedRating[] = [{ stars: 5, createdAt: daysAgo(100) }];
    expect(computeRollingAverage(ratings, 30, now)).toEqual({ avg: 0, count: 0 });
  });
});
