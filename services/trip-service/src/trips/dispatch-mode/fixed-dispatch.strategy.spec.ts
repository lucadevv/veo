/**
 * FixedDispatchStrategy — tarifa FIXED = applyOfferingPricing(calculateFare(...), pricing):
 *   max(round((base + perKm·km + perMin·min) × multiplier × surge), minFareCents) [+ FEE_NIÑO plano].
 * El XL (multiplier 1.6) verifica que el multiplier de la oferta escala la tarifa firme.
 */
import { describe, it, expect } from 'vitest';
import { OFFERINGS, OfferingId } from '@veo/shared-types';
import { FixedDispatchStrategy } from './fixed-dispatch.strategy';

const xl = OFFERINGS[OfferingId.VEO_XL].pricing; // multiplier 1.6, minFare 500
const baseInput = {
  floorCents: 700,
  route: { distanceMeters: 5000, durationSeconds: 600 }, // servicio 1500
  surge: 1.0,
  childMode: false,
  pricing: xl,
};

describe('FixedDispatchStrategy · resolveCreation', () => {
  const strategy = new FixedDispatchStrategy();

  it('aplica la política de la oferta a la tarifa base (XL ×1.6 → 2400)', () => {
    const out = strategy.resolveCreation({ ...baseInput });
    // calculateFare 1500 × multiplier 1.6 = 2400
    expect(out.fareCents).toBe(2400);
    expect(out.negotiationSeq).toBe(0);
  });

  it('F2.4 · la tarifa base configurable mueve la firme (700/140/40 ×1.6 XL → 2880)', () => {
    const out = strategy.resolveCreation({
      ...baseInput,
      baseFareCents: 700,
      perKmCents: 140,
      perMinCents: 40,
    });
    // servicio (700 + 140·5 + 40·10) = 1800; ×1.6 = 2880
    expect(out.fareCents).toBe(2880);
    expect(out.negotiationSeq).toBe(0);
  });

  it('el surge escala la tarifa firme (XL ×1.6 ×1.5 → 3600)', () => {
    const out = strategy.resolveCreation({ ...baseInput, surge: 1.5 });
    // calculateFare(1500 ×1.5)=2250 × multiplier 1.6 = 3600
    expect(out.fareCents).toBe(3600);
  });
});
