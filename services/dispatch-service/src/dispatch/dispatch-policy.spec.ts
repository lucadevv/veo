import { describe, it, expect } from 'vitest';
import {
  radiusKmToKRing,
  fixedRingBounds,
  fixedKmSteps,
  parsePolicyV2,
  DEFAULT_EXPAND_INTERVAL_SEC,
  MAX_POLICY_K_RING,
  type FixedPolicy,
} from './dispatch-policy';

describe('radiusKmToKRing — mapeo km → k-ring (0.3km por anillo, clamp 1..8)', () => {
  it('mapea cada radio al k-ring más chico que lo cubre', () => {
    // ceil(km / 0.3), clamp 1..8
    expect(radiusKmToKRing(0.3)).toBe(1); // 0.3/0.3 = 1
    expect(radiusKmToKRing(0.1)).toBe(1); // ceil(0.33) = 1
    expect(radiusKmToKRing(0.31)).toBe(2); // ceil(1.03) = 2
    expect(radiusKmToKRing(0.6)).toBe(2); // 0.6/0.3 = 2
    expect(radiusKmToKRing(0.9)).toBe(3);
    expect(radiusKmToKRing(1.2)).toBe(4);
    expect(radiusKmToKRing(2.4)).toBe(8); // 2.4/0.3 = 8
  });

  it('clampa por debajo a 1 (radio ínfimo/cero/negativo → k1)', () => {
    expect(radiusKmToKRing(0)).toBe(1);
    expect(radiusKmToKRing(0.05)).toBe(1);
    expect(radiusKmToKRing(-5)).toBe(1);
  });

  it('clampa por arriba a 8 (radio enorme → k8, techo H3/latencia)', () => {
    expect(radiusKmToKRing(2.5)).toBe(MAX_POLICY_K_RING);
    expect(radiusKmToKRing(10)).toBe(8);
    expect(radiusKmToKRing(1_000)).toBe(8);
  });

  it('NaN/Infinity (no-finito) → k1 (piso seguro, no crashea el hot-path)', () => {
    expect(radiusKmToKRing(NaN)).toBe(1);
    expect(radiusKmToKRing(Infinity)).toBe(1); // no-finito → piso seguro (no explota Redis con un disco infinito)
    expect(radiusKmToKRing(Number.NaN)).toBe(1);
  });
});

const FIXED: FixedPolicy = {
  initialRadiusKm: 0.6,
  incrementKm: 0.3,
  maxRadiusKm: 1.5,
  targetDrivers: 3,
  offerTimeoutSec: 20,
  expandIntervalSec: 8,
};

describe('fixedRingBounds — startK/maxK del matcher FIXED v2', () => {
  it('startK=initial, maxK=max', () => {
    expect(fixedRingBounds(FIXED)).toEqual({ startK: 2, maxK: 5 }); // 0.6→k2, 1.5→k5
  });

  it('maxK nunca es menor que startK (config invertida se auto-protege)', () => {
    const inverted: FixedPolicy = { ...FIXED, initialRadiusKm: 1.5, maxRadiusKm: 0.6 };
    const { startK, maxK } = fixedRingBounds(inverted);
    expect(startK).toBe(5);
    expect(maxK).toBe(5); // max(5, radiusKmToKRing(0.6)=2) = 5
  });
});

describe('fixedKmSteps — pasos de km del radar-preview', () => {
  it('genera initial → +increment → … → max (inclusive)', () => {
    expect(fixedKmSteps(FIXED)).toEqual([0.6, 0.9, 1.2, 1.5]);
  });

  it('siempre incluye maxRadiusKm aunque el increment no caiga justo', () => {
    const steps = fixedKmSteps({ ...FIXED, initialRadiusKm: 0.5, incrementKm: 0.4, maxRadiusKm: 1.5 });
    expect(steps[steps.length - 1]).toBe(1.5);
  });

  it('capea la cantidad de pasos (acota el trabajo del radar)', () => {
    const steps = fixedKmSteps(
      { ...FIXED, initialRadiusKm: 0.3, incrementKm: 0.1, maxRadiusKm: 2.4 },
      4,
    );
    expect(steps.length).toBeLessThanOrEqual(4);
  });
});

describe('parsePolicyV2 — validación defensiva del JSON de policy_v2', () => {
  const valid = {
    FIXED: {
      initialRadiusKm: 0.6,
      incrementKm: 0.3,
      maxRadiusKm: 1.5,
      targetDrivers: 3,
      offerTimeoutSec: 20,
      expandIntervalSec: 8,
    },
    PUJA: { broadcastRadiusKm: 1.2, bidWindowSec: 60 },
  };

  it('parsea un JSON bien formado', () => {
    expect(parsePolicyV2(valid)).toEqual(valid);
  });

  it('null/no-objeto → null (degrada a v1)', () => {
    expect(parsePolicyV2(null)).toBeNull();
    expect(parsePolicyV2('nope')).toBeNull();
    expect(parsePolicyV2(42)).toBeNull();
  });

  it('falta FIXED o PUJA → null', () => {
    expect(parsePolicyV2({ FIXED: valid.FIXED })).toBeNull();
    expect(parsePolicyV2({ PUJA: valid.PUJA })).toBeNull();
  });

  it('campo numérico faltante o no-finito → null', () => {
    expect(parsePolicyV2({ ...valid, FIXED: { ...valid.FIXED, targetDrivers: 'x' } })).toBeNull();
    expect(parsePolicyV2({ ...valid, PUJA: { ...valid.PUJA, broadcastRadiusKm: NaN } })).toBeNull();
  });

  it('expandIntervalSec ausente → default (compat con JSON viejo)', () => {
    const { expandIntervalSec, ...fixedNoExpand } = valid.FIXED;
    const parsed = parsePolicyV2({ ...valid, FIXED: fixedNoExpand });
    expect(parsed?.FIXED.expandIntervalSec).toBe(DEFAULT_EXPAND_INTERVAL_SEC);
  });
});
