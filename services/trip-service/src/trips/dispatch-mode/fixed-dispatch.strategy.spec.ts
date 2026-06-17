/**
 * FixedDispatchStrategy (B5-1.d) — el FLIP del modelo de energía gateado por `energyModelEnabled`:
 *  - OFF (default): fórmula vieja (fuel global plegado al per-km y escalado por el multiplier).
 *  - ON: fórmula nueva (calculateOfferingFare: energía pass-through, multiplier solo posición).
 * El XL (multiplier 1.6) distingue los dos modelos: con la vieja la energía se infla ×1.6.
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

describe('FixedDispatchStrategy · B5-1.d FLIP', () => {
  const strategy = new FixedDispatchStrategy();

  it('flag OFF (default) → fórmula VIEJA: fuel plegado y escalado por el multiplier (XL = 2720)', () => {
    const out = strategy.resolveCreation({ ...baseInput, fuelPerKmCents: 40 });
    // calculateFare 1700 (incluye fuel) × multiplier 1.6 = 2720
    expect(out.fareCents).toBe(2720);
    expect(out.negotiationSeq).toBe(0);
  });

  it('flag ON → fórmula NUEVA: energía pass-through (NO ×multiplier) → XL = 2600', () => {
    const out = strategy.resolveCreation({
      ...baseInput,
      energyModelEnabled: true,
      energyPerKmCents: 40,
    });
    // servicio 1500×1.6 = 2400; + energía 40·5 = 200 → 2600 (la energía NO se infla por el 1.6)
    expect(out.fareCents).toBe(2600);
    expect(out.negotiationSeq).toBe(0);
  });

  it('flag ON sin precio de energía cargado → solo servicio posicionado (energía 0)', () => {
    const out = strategy.resolveCreation({ ...baseInput, energyModelEnabled: true, energyPerKmCents: 0 });
    expect(out.fareCents).toBe(2400); // 1500×1.6, sin energía
  });
});
