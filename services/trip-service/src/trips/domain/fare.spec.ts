import { describe, it, expect } from 'vitest';
import { ValidationError, money } from '@veo/utils';
import {
  OFFERINGS,
  OfferingId,
  CHILD_MODE_FEE_CENTS as SHARED_CHILD_MODE_FEE_CENTS,
} from '@veo/shared-types';
import {
  calculateFare,
  applyOfferingPricing,
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

  it('anti-divergencia: el recargo de niño de fare ES el de @veo/shared-types (sin copia local)', () => {
    // fare.ts ya no declara su propia copia: re-exporta la constante de @veo/shared-types. Si alguien
    // reintroduce un espejo local con otro valor, este test (y el cálculo de arriba) lo cazan.
    expect(CHILD_MODE_FEE_CENTS).toBe(SHARED_CHILD_MODE_FEE_CENTS);
    expect(CHILD_MODE_FEE_CENTS).toBe(200);
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

describe('ADR 013 §1.7 · applyOfferingPricing (tarifa firme desde base — FUENTE ÚNICA)', () => {
  // La consumen FixedDispatchStrategy (create FIXED) y el re-quote de la parada mid-trip: estos
  // tests fijan la fórmula max(round(base × multiplier), minFareCents) UNA sola vez.

  it('confort ×1.25: escala la base y redondea a céntimos enteros (Math.round)', () => {
    // 1590 × 1.25 = 1987.5 → 1988 (mismo redondeo scaleMoney que el surge de calculateFare).
    const fare = applyOfferingPricing(money(1590), OFFERINGS[OfferingId.VEO_CONFORT].pricing);
    expect(fare.cents).toBe(1988);
  });

  it('moto ×0.55: escala hacia abajo (la moto es MÁS barata, nunca tasa de auto)', () => {
    // 1500 × 0.55 = 825 (la mínima de 300 no aplica: 825 > 300).
    const fare = applyOfferingPricing(money(1500), OFFERINGS[OfferingId.VEO_MOTO].pricing);
    expect(fare.cents).toBe(825);
  });

  it('moto: la MÍNIMA (S/3.00) pisa cuando la base escalada queda por debajo', () => {
    // 400 × 0.55 = 220 < 300 → cobra la mínima de la oferta.
    const fare = applyOfferingPricing(money(400), OFFERINGS[OfferingId.VEO_MOTO].pricing);
    expect(fare.cents).toBe(OFFERINGS[OfferingId.VEO_MOTO].pricing.minFareCents);
  });

  it('económico ×1.0: identidad por encima de la mínima; mínima (S/5.00) por debajo', () => {
    expect(applyOfferingPricing(money(1500), OFFERINGS[OfferingId.VEO_ECONOMICO].pricing).cents).toBe(1500);
    expect(applyOfferingPricing(money(400), OFFERINGS[OfferingId.VEO_ECONOMICO].pricing).cents).toBe(
      OFFERINGS[OfferingId.VEO_ECONOMICO].pricing.minFareCents,
    );
  });

  it('preserva la currency de la base', () => {
    expect(applyOfferingPricing(money(1500), OFFERINGS[OfferingId.VEO_XL].pricing).currency).toBe('PEN');
  });
});
