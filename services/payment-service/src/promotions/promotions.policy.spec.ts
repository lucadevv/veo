import { describe, expect, it } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import {
  computeDiscountCents,
  evaluatePromo,
  normalizeCode,
  type PromoLike,
} from './promotions.policy';

const base: PromoLike = {
  kind: 'PERCENTAGE',
  value: 50,
  maxDiscountCents: null,
  minFareCents: 0,
  startsAt: null,
  endsAt: null,
  maxTotalUses: 0,
  maxUsesPerUser: 1,
  active: true,
};

const noUsage = { totalUses: 0, userUses: 0 };

describe('normalizeCode', () => {
  it('mayúsculas y trim', () => {
    expect(normalizeCode('  primerViaje ')).toBe('PRIMERVIAJE');
  });
});

describe('computeDiscountCents', () => {
  it('porcentaje sin tope', () => {
    expect(computeDiscountCents(base, 2000)).toBe(1000); // 50% de 2000
  });

  it('porcentaje con tope', () => {
    expect(computeDiscountCents({ ...base, maxDiscountCents: 1500 }, 4000)).toBe(1500); // 2000→tope 1500
  });

  it('porcentaje hace floor', () => {
    expect(computeDiscountCents({ ...base, value: 33 }, 1000)).toBe(330); // floor(330.0)
    expect(computeDiscountCents({ ...base, value: 33 }, 1001)).toBe(330); // floor(330.33)
  });

  it('fijo, topado al bruto', () => {
    const fixed: PromoLike = { ...base, kind: 'FIXED', value: 500 };
    expect(computeDiscountCents(fixed, 2000)).toBe(500);
    expect(computeDiscountCents(fixed, 300)).toBe(300); // nunca excede el bruto
  });

  it('rechaza bruto inválido', () => {
    expect(() => computeDiscountCents(base, -1)).toThrow(InvalidStateError);
    expect(() => computeDiscountCents(base, 10.5)).toThrow(InvalidStateError);
  });
});

describe('evaluatePromo', () => {
  it('aplica y devuelve el descuento', () => {
    const r = evaluatePromo(base, 2000, noUsage);
    expect(r).toEqual({ valid: true, discountCents: 1000 });
  });

  it('inactiva', () => {
    expect(evaluatePromo({ ...base, active: false }, 2000, noUsage)).toMatchObject({
      valid: false,
      reason: 'INACTIVE',
    });
  });

  it('aún no vigente', () => {
    const future = new Date(Date.now() + 3_600_000);
    expect(evaluatePromo({ ...base, startsAt: future }, 2000, noUsage)).toMatchObject({
      valid: false,
      reason: 'NOT_STARTED',
    });
  });

  it('expirada', () => {
    const past = new Date(Date.now() - 3_600_000);
    expect(evaluatePromo({ ...base, endsAt: past }, 2000, noUsage)).toMatchObject({
      valid: false,
      reason: 'EXPIRED',
    });
  });

  it('bajo el mínimo', () => {
    expect(evaluatePromo({ ...base, minFareCents: 3000 }, 2000, noUsage)).toMatchObject({
      valid: false,
      reason: 'BELOW_MIN_FARE',
    });
  });

  it('agotada en total', () => {
    expect(
      evaluatePromo({ ...base, maxTotalUses: 5 }, 2000, { totalUses: 5, userUses: 0 }),
    ).toMatchObject({ valid: false, reason: 'EXHAUSTED_TOTAL' });
  });

  it('agotada por usuario (un uso)', () => {
    expect(evaluatePromo(base, 2000, { totalUses: 1, userUses: 1 })).toMatchObject({
      valid: false,
      reason: 'EXHAUSTED_USER',
    });
  });
});
