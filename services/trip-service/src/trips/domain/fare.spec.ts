import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  calculateFare,
  BASE_FARE_CENTS,
  PER_KM_CENTS,
  PER_MIN_CENTS,
  CHILD_MODE_FEE_CENTS,
} from './fare';

describe('BR-T05 · cálculo de tarifa', () => {
  it('tarifa base sin distancia ni tiempo = banderazo', () => {
    const fare = calculateFare({ distanceMeters: 0, durationSeconds: 0 });
    expect(fare.cents).toBe(BASE_FARE_CENTS);
    expect(fare.currency).toBe('PEN');
  });

  it('aplica por-km y por-min correctamente (5 km, 10 min)', () => {
    const fare = calculateFare({ distanceMeters: 5000, durationSeconds: 600 });
    // 600 + 120*5 + 30*10 = 600 + 600 + 300 = 1500
    expect(fare.cents).toBe(BASE_FARE_CENTS + PER_KM_CENTS * 5 + PER_MIN_CENTS * 10);
    expect(fare.cents).toBe(1500);
  });

  it('aplica surge multiplicador antes del recargo de niño', () => {
    const fare = calculateFare({ distanceMeters: 5000, durationSeconds: 600, surgeMultiplier: 1.5 });
    // 1500 * 1.5 = 2250
    expect(fare.cents).toBe(2250);
  });

  it('modo niño suma 200 céntimos (S/2) después del surge', () => {
    const fare = calculateFare({
      distanceMeters: 5000,
      durationSeconds: 600,
      surgeMultiplier: 1.5,
      childMode: true,
    });
    // 1500 * 1.5 + 200 = 2450
    expect(fare.cents).toBe(2250 + CHILD_MODE_FEE_CENTS);
  });

  it('surge por defecto es 1.0', () => {
    const a = calculateFare({ distanceMeters: 3000, durationSeconds: 300 });
    const b = calculateFare({ distanceMeters: 3000, durationSeconds: 300, surgeMultiplier: 1.0 });
    expect(a.cents).toBe(b.cents);
  });

  it('rechaza surge fuera de rango [1.0, 2.0]', () => {
    expect(() => calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 0.9 })).toThrow(
      ValidationError,
    );
    expect(() => calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 2.1 })).toThrow(
      ValidationError,
    );
  });

  it('acepta surge en los extremos 1.0 y 2.0', () => {
    expect(calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 1.0 }).cents).toBeGreaterThan(0);
    const max = calculateFare({ distanceMeters: 5000, durationSeconds: 600, surgeMultiplier: 2.0 });
    expect(max.cents).toBe(3000); // 1500 * 2
  });

  it('rechaza distancia/duración negativas o no finitas', () => {
    expect(() => calculateFare({ distanceMeters: -1, durationSeconds: 60 })).toThrow(ValidationError);
    expect(() => calculateFare({ distanceMeters: 1000, durationSeconds: -1 })).toThrow(ValidationError);
    expect(() => calculateFare({ distanceMeters: Number.NaN, durationSeconds: 60 })).toThrow(ValidationError);
  });
});
