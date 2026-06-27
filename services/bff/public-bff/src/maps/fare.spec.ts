import { describe, it, expect } from 'vitest';
import { OFFERING_LIST } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';
import {
  categoryFareCents,
  categoryFareCentsV2,
  shadowCompareCategoryFare,
  minFareForCategory,
  BASE_FARE_CENTS,
  PER_KM_CENTS,
  PER_MIN_CENTS,
  MIN_FARE_CENTS,
  MOTO_MIN_FARE_CENTS,
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

  it('B3 · el recargo de combustible se pliega al per-km (5 km, +40 céntimos/km = +200 → 1700)', () => {
    expect(categoryFareCents(5000, 600, 1.0, MIN_FARE_CENTS, 40)).toBe(1700);
    // default 0 = sin recargo (no cambia el comportamiento previo).
    expect(categoryFareCents(5000, 600, 1.0, MIN_FARE_CENTS, 0)).toBe(1500);
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

  // ADR 013 (Lote C): el catálogo ya NO se define en fare.ts — es OFFERING_LIST de @veo/shared-types.
  it('el catálogo (OFFERING_LIST) incluye el tier MOTO y las ofertas de auto (moto→económico→normal→premium→xl)', () => {
    // B5-4/F2.3: OFFERING_LIST es el catálogo COMPLETO (5 RIDE visibles +premium, 3 verticales ocultas
    // por defaultEnabled:false). El quote filtra las ocultas; acá verificamos el catálogo base entero.
    expect(OFFERING_LIST.map((o) => o.id)).toEqual([
      'veo_moto',
      'veo_economico',
      'veo_confort',
      'veo_premium',
      'veo_xl',
      'veo_ambulance',
      'veo_tow',
      'veo_mechanic',
    ]);
    const moto = OFFERING_LIST.find((o) => o.id === 'veo_moto');
    expect(moto?.vehicleClass).toBe('MOTO');
    expect(moto?.pricing.multiplier).toBeLessThan(1.0); // mototaxi es más barato que el económico
    const economico = OFFERING_LIST.find((o) => o.id === 'veo_economico');
    expect(economico?.pricing.multiplier).toBe(1.0);
    expect(economico?.vehicleClass).toBe('CAR');
  });

  // ADR 013: las mínimas del preview se DERIVAN del catálogo (una sola fuente — si esto falla,
  // alguien re-definió la política en el BFF en vez de importarla).
  it('las mínimas del preview son las del catálogo (derivadas, no re-definidas)', () => {
    expect(MOTO_MIN_FARE_CENTS).toBe(
      OFFERING_LIST.find((o) => o.id === 'veo_moto')?.pricing.minFareCents,
    );
    expect(MIN_FARE_CENTS).toBe(
      OFFERING_LIST.find((o) => o.id === 'veo_economico')?.pricing.minFareCents,
    );
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

describe('B5-1 · categoryFareCentsV2 (quote · energía pass-through · multiplier solo posición)', () => {
  it('económico (×1.0) sin energía → 1500; energía +40/km es pass-through (+200) → 1700', () => {
    expect(categoryFareCentsV2(5000, 600, 1.0, MIN_FARE_CENTS, 0)).toBe(1500);
    expect(categoryFareCentsV2(5000, 600, 1.0, MIN_FARE_CENTS, 40)).toBe(1700);
  });

  it('XL (×1.6): el multiplier escala el servicio, NO la energía → 2600 (no 2720)', () => {
    expect(categoryFareCentsV2(5000, 600, 1.6, MIN_FARE_CENTS, 40)).toBe(2600);
  });

  it('respeta la mínima y redondea a S/0.10', () => {
    expect(categoryFareCentsV2(0, 0, 1.0, 500, 0)).toBe(600); // BASE 600 > 500
    expect(categoryFareCentsV2(0, 0, 0.55, 300, 0)).toBe(330); // 600×0.55=330 > 300
  });

  it('rechaza insumos inválidos', () => {
    expect(() => categoryFareCentsV2(5000, 600, 1.0, 500, -1)).toThrow(ValidationError);
    expect(() => categoryFareCentsV2(-1, 600, 1.0)).toThrow(ValidationError);
  });
});

describe('B5-1 · shadowCompareCategoryFare (quote: viejo vs nuevo)', () => {
  it('económico (×1.0): delta 0', () => {
    expect(shadowCompareCategoryFare(5000, 600, 1.0, 500, 40, 40)).toEqual({
      oldCents: 1700,
      newCents: 1700,
      deltaCents: 0,
    });
  });

  it('XL (×1.6): el nuevo es MENOR (energía ya no inflada por el multiplier) → delta -120', () => {
    const d = shadowCompareCategoryFare(5000, 600, 1.6, 500, 40, 40);
    expect(d.oldCents).toBe(2720);
    expect(d.newCents).toBe(2600);
    expect(d.deltaCents).toBe(-120);
  });
});
