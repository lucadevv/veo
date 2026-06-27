import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  PAIS,
  isPais,
  costPerKmCentsFor,
  capCentsForDistance,
  assertFullRouteCap,
  assertAgreedPriceCap,
  assertTramoCap,
  MAX_TOLLS_CENTS,
  type CostPerKmConfig,
} from './cost-cap';

const CONFIG: CostPerKmConfig = { [PAIS.PE]: 150, [PAIS.EC]: 50 };

describe('cost-cap · capCentsForDistance (costo/km × dist + peaje ÷ asientos · Int sin float)', () => {
  it('10km · 150c/km · 4 asientos · sin peaje → tope 375', () => {
    // (10000/1000) * 150 + 0 / 4 = (10 * 150) / 4 = 1500 / 4 = 375
    expect(capCentsForDistance(10_000, 150, 4, 0)).toBe(375);
  });

  it('PEAJE: 10km · 150c/km · 4 asientos · peaje 800 → (1500 + 800)/4 = 575', () => {
    // El peaje se SUMA al costo del viaje y RECIÉN se divide entre asientos (NO va en el per-km).
    expect(capCentsForDistance(10_000, 150, 4, 800)).toBe(575);
  });

  it('el peaje se reparte entre asientos, no se carga entero: 1 asiento absorbe todo el peaje', () => {
    // (10 * 150 + 800) / 1 = 2300. vs 4 asientos → 575. El divisor reparte distancia + peaje juntos.
    expect(capCentsForDistance(10_000, 150, 1, 800)).toBe(2300);
  });

  it('redondea a entero (Math.floor) — sin float en el resultado, incluso con peaje', () => {
    // (3333/1000) * 150 + 100 / 3 = (499.95 + 100) / 3 = 599.95 / 3 = 199.98 → floor 199
    const tope = capCentsForDistance(3333, 150, 3, 100);
    expect(tope).toBe(199);
    expect(Number.isInteger(tope)).toBe(true);
  });

  it('redondea HACIA ABAJO (floor, NO round) en .5: un tope nunca excede el costo real', () => {
    // (5000/1000) * 100 + 0 / 8 = 500 / 8 = 62.5 → floor 62 (round daría 63 = micro-lucro).
    const tope = capCentsForDistance(5_000, 100, 8, 0);
    expect(tope).toBe(62);
    expect(Number.isInteger(tope)).toBe(true);
  });

  it('un solo asiento sin peaje: tope = distancia_km × costo/km completo', () => {
    expect(capCentsForDistance(25_500, 150, 1, 0)).toBe(3825); // 25.5km × 150 = 3825
  });

  it('asientosTotales <= 0 → ValidationError (no divide por cero)', () => {
    expect(() => capCentsForDistance(10_000, 150, 0, 0)).toThrow(ValidationError);
  });

  it('peaje negativo → ValidationError (estado inválido, no se silencia a 0)', () => {
    expect(() => capCentsForDistance(10_000, 150, 4, -1)).toThrow(ValidationError);
  });

  it('peaje no entero → ValidationError (dinero en céntimos Int, nunca float)', () => {
    expect(() => capCentsForDistance(10_000, 150, 4, 12.5)).toThrow(ValidationError);
  });
});

describe('cost-cap · MAX_TOLLS_CENTS (techo de cordura del peaje)', () => {
  it('es S/500 en céntimos (guard anti-absurdo, no valor fino de negocio)', () => {
    expect(MAX_TOLLS_CENTS).toBe(50_000);
  });
});

describe('cost-cap · costPerKmCentsFor (fallback de env, país tipado)', () => {
  it('PE → 150', () => expect(costPerKmCentsFor(PAIS.PE, CONFIG)).toBe(150));
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

describe('cost-cap · assertFullRouteCap (el peaje SUBE el tope full-route)', () => {
  // 10km · 150c/km · 4 asientos · sin peaje → tope 375
  const base = { distanceMeters: 10_000, costPerKmCents: 150, asientosTotales: 4, tollsCents: 0 };

  it('precioBase == tope → OK (límite inclusivo)', () => {
    expect(() => assertFullRouteCap({ ...base, precioBaseCentimos: 375 })).not.toThrow();
  });
  it('precioBase < tope → OK', () => {
    expect(() => assertFullRouteCap({ ...base, precioBaseCentimos: 100 })).not.toThrow();
  });
  it('precioBase > tope sin peaje → ValidationError con tope esperado en details', () => {
    try {
      assertFullRouteCap({ ...base, precioBaseCentimos: 376 });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        precioBaseCentimos: 376,
        topeCentimos: 375,
        distanceMeters: 10_000,
        tollsCents: 0,
      });
    }
  });
  it('CON peaje el tope sube: 376 pasa cuando hay peaje 800 (tope (1500+800)/4 = 575)', () => {
    expect(() =>
      assertFullRouteCap({ ...base, tollsCents: 800, precioBaseCentimos: 575 }),
    ).not.toThrow();
    // 576 sigue excediendo el tope CON peaje.
    expect(() =>
      assertFullRouteCap({ ...base, tollsCents: 800, precioBaseCentimos: 576 }),
    ).toThrow(ValidationError);
  });
});

describe('cost-cap · assertAgreedPriceCap (escudo anti-lucro del precioAcordado al reservar)', () => {
  // 10km · 150c/km · 4 asientos · sin peaje → tope 375 (por asiento).
  const base = { distanceMeters: 10_000, costPerKmCents: 150, asientosTotales: 4, tollsCents: 0 };

  it('precioAcordado == tope → OK (límite inclusivo)', () => {
    expect(() => assertAgreedPriceCap({ ...base, precioAcordadoCentimos: 375 })).not.toThrow();
  });
  it('precioAcordado < tope → OK', () => {
    expect(() => assertAgreedPriceCap({ ...base, precioAcordadoCentimos: 300 })).not.toThrow();
  });
  it('precioAcordado > tope → ValidationError con su propio mensaje + tope en details', () => {
    try {
      assertAgreedPriceCap({ ...base, precioAcordadoCentimos: 376 });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      // El mensaje culpa al specialRequest (no al precioBase) — la causa real del exceso al reservar.
      expect((err as ValidationError).message).toContain('specialRequest');
      expect((err as ValidationError).details).toMatchObject({
        precioAcordadoCentimos: 376,
        topeCentimos: 375,
      });
    }
  });
  it('el peaje SUBE el tope también acá (full-route): 575 pasa con peaje 800 (tope (1500+800)/4)', () => {
    expect(() =>
      assertAgreedPriceCap({ ...base, tollsCents: 800, precioAcordadoCentimos: 575 }),
    ).not.toThrow();
    expect(() =>
      assertAgreedPriceCap({ ...base, tollsCents: 800, precioAcordadoCentimos: 576 }),
    ).toThrow(ValidationError);
  });
});

describe('cost-cap · assertTramoCap (peaje 0 en sub-segmento; el orquestador decide cuándo es full-route)', () => {
  it('sub-segmento (tollsCents 0) con precio > topeTramo → ValidationError (incluye los órdenes del tramo)', () => {
    // 5km · 150c/km · 2 asientos · sin peaje → (5 * 150)/2 = 375
    try {
      assertTramoCap({
        desdeOrden: 1,
        hastaOrden: 2,
        precioCentimos: 400,
        distanceMeters: 5_000,
        costPerKmCents: 150,
        asientosTotales: 2,
        tollsCents: 0,
      });
      throw new Error('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toMatchObject({
        desdeOrden: 1,
        hastaOrden: 2,
        precioCentimos: 400,
        topeCentimos: 375,
        tollsCents: 0,
      });
    }
  });
  it('sub-segmento en el tope → OK', () => {
    expect(() =>
      assertTramoCap({
        desdeOrden: 1,
        hastaOrden: 2,
        precioCentimos: 375,
        distanceMeters: 5_000,
        costPerKmCents: 150,
        asientosTotales: 2,
        tollsCents: 0,
      }),
    ).not.toThrow();
  });
  it('tramo full-route (el orquestador pasa el peaje) sube el tope: 5km · 2 asientos · peaje 800 → (750+800)/2 = 775', () => {
    // Con peaje 800 el tope del tramo full-route es 775; 775 pasa, 776 revienta.
    expect(() =>
      assertTramoCap({
        desdeOrden: 0,
        hastaOrden: 1,
        precioCentimos: 775,
        distanceMeters: 5_000,
        costPerKmCents: 150,
        asientosTotales: 2,
        tollsCents: 800,
      }),
    ).not.toThrow();
    expect(() =>
      assertTramoCap({
        desdeOrden: 0,
        hastaOrden: 1,
        precioCentimos: 776,
        distanceMeters: 5_000,
        costPerKmCents: 150,
        asientosTotales: 2,
        tollsCents: 800,
      }),
    ).toThrow(ValidationError);
  });
});
