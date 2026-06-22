import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  PAIS,
  isPais,
  costPerKmCentsFor,
  capCentsForDistance,
  assertFullRouteCap,
  assertTramoCap,
  type CostPerKmConfig,
} from './cost-cap';

const CONFIG: CostPerKmConfig = { [PAIS.PE]: 100, [PAIS.EC]: 50 };

describe('cost-cap · capCentsForDistance (cuenta de céntimos exacta, Int sin float)', () => {
  it('10km · 100c/km · 4 asientos → tope 250 (la cuenta canónica del prompt)', () => {
    // (10000/1000) * 100 / 4 = 10 * 100 / 4 = 1000 / 4 = 250
    expect(capCentsForDistance(10_000, 100, 4)).toBe(250);
  });

  it('redondea a entero (Math.floor) — sin float en el resultado', () => {
    // (3333/1000) * 100 / 3 = 3.333 * 100 / 3 = 333.3 / 3 = 111.1 → floor 111
    const tope = capCentsForDistance(3333, 100, 3);
    expect(tope).toBe(111);
    expect(Number.isInteger(tope)).toBe(true);
  });

  it('FIX 4 — redondea HACIA ABAJO (floor, NO round) en .5: un tope nunca excede el costo real', () => {
    // (5000/1000) * 100 / 8 = 5 * 100 / 8 = 500 / 8 = 62.5 → floor 62 (round daría 63 = micro-lucro).
    const tope = capCentsForDistance(5_000, 100, 8);
    expect(tope).toBe(62);
    expect(Number.isInteger(tope)).toBe(true);
  });

  it('un solo asiento: tope = distancia_km × costo/km completo', () => {
    expect(capCentsForDistance(25_500, 100, 1)).toBe(2550); // 25.5km × 100 = 2550
  });

  it('asientosTotales <= 0 → ValidationError (no divide por cero)', () => {
    expect(() => capCentsForDistance(10_000, 100, 0)).toThrow(ValidationError);
  });
});

describe('cost-cap · costPerKmCentsFor (país tipado, EC usa su tarifa)', () => {
  it('PE → 100', () => expect(costPerKmCentsFor(PAIS.PE, CONFIG)).toBe(100));
  it('EC → 50', () => expect(costPerKmCentsFor(PAIS.EC, CONFIG)).toBe(50));
  it('país no soportado → ValidationError', () => {
    expect(() => costPerKmCentsFor('AR', CONFIG)).toThrow(ValidationError);
  });
  it('isPais narrowea PE/EC y rechaza el resto', () => {
    expect(isPais('PE')).toBe(true);
    expect(isPais('EC')).toBe(true);
    expect(isPais('US')).toBe(false);
  });
});

describe('cost-cap · assertFullRouteCap', () => {
  const base = { distanceMeters: 10_000, costPerKmCents: 100, asientosTotales: 4 }; // tope 250

  it('precioBase == tope → OK (límite inclusivo)', () => {
    expect(() => assertFullRouteCap({ ...base, precioBaseCentimos: 250 })).not.toThrow();
  });
  it('precioBase < tope → OK', () => {
    expect(() => assertFullRouteCap({ ...base, precioBaseCentimos: 100 })).not.toThrow();
  });
  it('precioBase > tope → ValidationError con tope esperado en details', () => {
    try {
      assertFullRouteCap({ ...base, precioBaseCentimos: 251 });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        precioBaseCentimos: 251,
        topeCentimos: 250,
        distanceMeters: 10_000,
      });
    }
  });
});

describe('cost-cap · assertTramoCap', () => {
  it('tramo con precio > topeTramo → ValidationError (incluye los órdenes del tramo)', () => {
    // 5km · 100c/km · 2 asientos → (5 * 100)/2 = 250
    try {
      assertTramoCap({
        desdeOrden: 0,
        hastaOrden: 1,
        precioCentimos: 300,
        distanceMeters: 5_000,
        costPerKmCents: 100,
        asientosTotales: 2,
      });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        desdeOrden: 0,
        hastaOrden: 1,
        precioCentimos: 300,
        topeCentimos: 250,
      });
    }
  });
  it('tramo en el tope → OK', () => {
    expect(() =>
      assertTramoCap({
        desdeOrden: 0,
        hastaOrden: 1,
        precioCentimos: 250,
        distanceMeters: 5_000,
        costPerKmCents: 100,
        asientosTotales: 2,
      }),
    ).not.toThrow();
  });
});
