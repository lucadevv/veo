import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  categoryFareCents,
  minFareForCategory,
  BASE_FARE_CENTS,
  PER_KM_CENTS,
  PER_MIN_CENTS,
  MIN_FARE_CENTS,
  MOTO_MIN_FARE_CENTS,
  RIDE_CATEGORIES,
} from './fare';

describe('cálculo de tarifa de previsualización (/maps/quote)', () => {
  it('tarifa base sin distancia ni tiempo respeta el banderazo redondeado', () => {
    // 600 céntimos, ya múltiplo de 10 → 600.
    expect(categoryFareCents(0, 0, 1.0)).toBe(BASE_FARE_CENTS);
  });

  it('aplica por-km y por-min sobre la categoría económica (5 km, 10 min)', () => {
    // 600 + 120*5 + 30*10 = 1500 → *1.0 = 1500.
    const expected = BASE_FARE_CENTS + PER_KM_CENTS * 5 + PER_MIN_CENTS * 10;
    expect(categoryFareCents(5000, 600, 1.0)).toBe(expected);
    expect(categoryFareCents(5000, 600, 1.0)).toBe(1500);
  });

  it('aplica el multiplicador de categoría y redondea a S/0.10', () => {
    // base 1500 * 1.25 = 1875 → redondeo a 10 → 1880.
    expect(categoryFareCents(5000, 600, 1.25)).toBe(1880);
    // base 1500 * 1.6 = 2400 (ya múltiplo de 10).
    expect(categoryFareCents(5000, 600, 1.6)).toBe(2400);
  });

  it('respeta la tarifa mínima (piso) cuando el subtotal cae por debajo', () => {
    // 600 * 0.5 = 300 → por debajo del mínimo S/5.00 → se eleva a 500.
    expect(categoryFareCents(0, 0, 0.5)).toBe(MIN_FARE_CENTS);
  });

  it('el catálogo incluye el tier MOTO y las categorías de auto (moto→económico→premium)', () => {
    expect(RIDE_CATEGORIES.map((c) => c.id)).toEqual([
      'veo_moto',
      'veo_economico',
      'veo_confort',
      'veo_xl',
    ]);
    const moto = RIDE_CATEGORIES.find((c) => c.id === 'veo_moto');
    expect(moto?.vehicleType).toBe('MOTO');
    expect(moto?.multiplier).toBeLessThan(1.0); // mototaxi es más barato que el económico
    const economico = RIDE_CATEGORIES.find((c) => c.id === 'veo_economico');
    expect(economico?.multiplier).toBe(1.0);
    expect(economico?.vehicleType).toBe('CAR');
  });

  it('Ola 2B · el tier moto-taxi usa su tarifa mínima propia (menor que la de auto)', () => {
    expect(minFareForCategory('MOTO')).toBe(MOTO_MIN_FARE_CENTS);
    expect(minFareForCategory('CAR')).toBe(MIN_FARE_CENTS);
    expect(MOTO_MIN_FARE_CENTS).toBeLessThan(MIN_FARE_CENTS);
    // 600 * 0.55 = 330 → por encima de la mínima moto (300), respeta el cálculo.
    expect(categoryFareCents(0, 0, 0.55, MOTO_MIN_FARE_CENTS)).toBe(330);
  });

  it('rechaza distancia/duración negativas o no finitas', () => {
    expect(() => categoryFareCents(-1, 60, 1.0)).toThrow(ValidationError);
    expect(() => categoryFareCents(1000, -1, 1.0)).toThrow(ValidationError);
    expect(() => categoryFareCents(Number.NaN, 60, 1.0)).toThrow(ValidationError);
  });
});
