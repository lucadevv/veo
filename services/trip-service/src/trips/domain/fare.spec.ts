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
  calculateFirmFare,
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

  it('F2.4 · banderazo/km/min configurables del admin mueven la tarifa (700/140/40 → 1800)', () => {
    const fare = calculateFare({
      distanceMeters: 5000,
      durationSeconds: 600,
      baseFareCents: 700,
      perKmCents: 140,
      perMinCents: 40,
    });
    // 700 + 140*5 + 40*10 = 700 + 700 + 400 = 1800 (vs 1500 con las constantes)
    expect(fare.cents).toBe(1800);
  });

  it('F2.4 · sin el triple usa las constantes de código (retro-compat)', () => {
    expect(calculateFare({ distanceMeters: 5000, durationSeconds: 600 }).cents).toBe(1500);
  });

  it('aplica surge multiplicador a la base', () => {
    const fare = calculateFare({
      distanceMeters: 5000,
      durationSeconds: 600,
      surgeMultiplier: 1.5,
    });
    // 1500 * 1.5 = 2250
    expect(fare.cents).toBe(2250);
  });

  it('calculateFare NO suma el recargo de niño (es plano, lo aplica calculateFirmFare)', () => {
    const conChild = calculateFare({
      distanceMeters: 5000,
      durationSeconds: 600,
      surgeMultiplier: 1.5,
      childMode: true,
    });
    const sinChild = calculateFare({
      distanceMeters: 5000,
      durationSeconds: 600,
      surgeMultiplier: 1.5,
    });
    // calculateFare devuelve la BASE (2250) sin importar childMode: el fee lo suma calculateFirmFare al final.
    expect(conChild.cents).toBe(2250);
    expect(conChild.cents).toBe(sinChild.cents);
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
    expect(() =>
      calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 0.9 }),
    ).toThrow(ValidationError);
    expect(() =>
      calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 2.1 }),
    ).toThrow(ValidationError);
  });

  it('acepta surge en los extremos 1.0 y 2.0', () => {
    expect(
      calculateFare({ distanceMeters: 1000, durationSeconds: 60, surgeMultiplier: 1.0 }).cents,
    ).toBeGreaterThan(0);
    const max = calculateFare({ distanceMeters: 5000, durationSeconds: 600, surgeMultiplier: 2.0 });
    expect(max.cents).toBe(3000); // 1500 * 2
  });

  it('rechaza distancia/duración negativas o no finitas', () => {
    expect(() => calculateFare({ distanceMeters: -1, durationSeconds: 60 })).toThrow(
      ValidationError,
    );
    expect(() => calculateFare({ distanceMeters: 1000, durationSeconds: -1 })).toThrow(
      ValidationError,
    );
    expect(() => calculateFare({ distanceMeters: Number.NaN, durationSeconds: 60 })).toThrow(
      ValidationError,
    );
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
    expect(
      applyOfferingPricing(money(1500), OFFERINGS[OfferingId.VEO_ECONOMICO].pricing).cents,
    ).toBe(1500);
    expect(
      applyOfferingPricing(money(400), OFFERINGS[OfferingId.VEO_ECONOMICO].pricing).cents,
    ).toBe(OFFERINGS[OfferingId.VEO_ECONOMICO].pricing.minFareCents);
  });

  it('preserva la currency de la base', () => {
    expect(applyOfferingPricing(money(1500), OFFERINGS[OfferingId.VEO_XL].pricing).currency).toBe(
      'PEN',
    );
  });
});

describe('BR-T05 + BR-T07 · calculateFirmFare (tarifa firme + fee de niño PLANO)', () => {
  // FUENTE ÚNICA del cobro FIXED. El fee de niño NO lo escala el multiplier de la oferta ni el surge:
  // cuesta S/2.00 en cualquier tier (regresión que este bloque congela).
  const baseInput = { distanceMeters: 5000, durationSeconds: 600 }; // base = 1500

  it('sin modo niño = applyOfferingPricing(calculateFare): confort ×1.25 → 1875', () => {
    const fare = calculateFirmFare(baseInput, OFFERINGS[OfferingId.VEO_CONFORT].pricing);
    expect(fare.cents).toBe(1875); // 1500 × 1.25
  });

  it('el fee de niño es PLANO: se suma DESPUÉS del multiplier, el tier NO lo escala (confort ×1.25)', () => {
    const fare = calculateFirmFare(
      { ...baseInput, childMode: true },
      OFFERINGS[OfferingId.VEO_CONFORT].pricing,
    );
    // CORRECTO: 1500×1.25 + 200 = 2075.  BUG viejo (fee dentro de la base): (1500+200)×1.25 = 2125.
    expect(fare.cents).toBe(1875 + CHILD_MODE_FEE_CENTS);
    expect(fare.cents).toBe(2075);
  });

  it('el delta por modo niño es EXACTAMENTE S/2.00 en todos los tiers (moto ×0.55, confort ×1.25, xl ×1.6)', () => {
    for (const id of [OfferingId.VEO_MOTO, OfferingId.VEO_CONFORT, OfferingId.VEO_XL]) {
      const sin = calculateFirmFare(baseInput, OFFERINGS[id].pricing);
      const con = calculateFirmFare({ ...baseInput, childMode: true }, OFFERINGS[id].pricing);
      expect(con.cents - sin.cents).toBe(CHILD_MODE_FEE_CENTS);
    }
  });

  it('el fee de niño se suma AUN cuando la mínima de la oferta pisa la base', () => {
    // 400 × 0.55 = 220 < mínima moto → firm = mínima; + niño 200 plano.
    const smallInput = {
      distanceMeters: 0,
      durationSeconds: 0,
      baseFareCents: 400,
      perKmCents: 0,
      perMinCents: 0,
    };
    const con = calculateFirmFare(
      { ...smallInput, childMode: true },
      OFFERINGS[OfferingId.VEO_MOTO].pricing,
    );
    expect(con.cents).toBe(
      OFFERINGS[OfferingId.VEO_MOTO].pricing.minFareCents + CHILD_MODE_FEE_CENTS,
    );
  });
});
