/**
 * DispatchModeRegistry — la garantía OPEN/CLOSED: cada modo resuelve a su estrategia, y un modo SIN
 * estrategia registrada FALLA FUERTE (no cae silenciosamente en la rama PUJA, como pasaba con los
 * `if FIXED else PUJA` binarios antes del refactor).
 */
import { describe, it, expect } from 'vitest';
import { OFFERINGS, OfferingId, PricingMode, type OfferingPricingPolicy } from '@veo/shared-types';
import { DispatchModeRegistry } from './dispatch-mode.registry';

describe('DispatchModeRegistry · open/closed', () => {
  const registry = new DispatchModeRegistry(); // sin config → bidWindowSec al default

  it('forMode(PUJA) devuelve la estrategia de PUJA', () => {
    expect(registry.forMode(PricingMode.PUJA).mode).toBe(PricingMode.PUJA);
  });

  it('forMode(FIXED) devuelve la estrategia de FIXED', () => {
    expect(registry.forMode(PricingMode.FIXED).mode).toBe(PricingMode.FIXED);
  });

  it('un modo SIN estrategia registrada LANZA (no cae silencioso en PUJA)', () => {
    expect(() => registry.forMode('SURGE' as PricingMode)).toThrow(/SURGE/);
  });
});

describe('DispatchModeStrategy.resolveCreation · tarifa + seq por modo', () => {
  const registry = new DispatchModeRegistry();
  const route = { distanceMeters: 5000, durationSeconds: 600 };
  // ADR 013 §1.7 · la política de pricing viene del CATÁLOGO (fuente única; no se copia la tabla).
  const baseInput = {
    floorCents: 700,
    route,
    surge: 1,
    childMode: false,
    pricing: OFFERINGS[OfferingId.VEO_ECONOMICO].pricing,
  };

  it('PUJA: el bid válido ES el fareCents y abre el ciclo (seq=1)', () => {
    const out = registry
      .forMode(PricingMode.PUJA)
      .resolveCreation({ ...baseInput, bidCents: 1500 });
    expect(out).toEqual({ fareCents: 1500, negotiationSeq: 1 });
  });

  it('PUJA: sin bid → ValidationError', () => {
    expect(() =>
      registry.forMode(PricingMode.PUJA).resolveCreation({ ...baseInput, bidCents: undefined }),
    ).toThrow();
  });

  it('PUJA: bid bajo el piso → ValidationError', () => {
    expect(() =>
      registry.forMode(PricingMode.PUJA).resolveCreation({ ...baseInput, bidCents: 500 }),
    ).toThrow();
  });

  it('FIXED: ignora el bid, calcula por ruta y NO negocia (seq=0)', () => {
    const out = registry
      .forMode(PricingMode.FIXED)
      .resolveCreation({ ...baseInput, bidCents: 99999 });
    expect(out.negotiationSeq).toBe(0);
    expect(out.fareCents).toBeGreaterThan(0); // tarifa por ruta, NO el bid
    expect(out.fareCents).not.toBe(99999);
  });

  // ── ADR 013 §1.7 · el FIX del bug del multiplier: la tarifa firme aplica la política de la OFERTA ──

  it('FIXED · veo_moto aplica ×0.55 sobre la base: 1500 → 825 (round(1500×0.55), > minFare 300)', () => {
    // Base por ruta (5000m/600s, surge 1): 600 + 120·5 + 30·10 = 1500. Moto ya NO cobra la tarifa de
    // económico (el bug: cobraba MÁS que su preview).
    const out = registry.forMode(PricingMode.FIXED).resolveCreation({
      ...baseInput,
      pricing: OFFERINGS[OfferingId.VEO_MOTO].pricing,
    });
    expect(out.fareCents).toBe(825); // Math.round(1500 × 0.55), entero en céntimos
  });

  it('FIXED · veo_confort aplica ×1.25: 1500 → 1875', () => {
    const out = registry.forMode(PricingMode.FIXED).resolveCreation({
      ...baseInput,
      pricing: OFFERINGS[OfferingId.VEO_CONFORT].pricing,
    });
    expect(out.fareCents).toBe(1875); // Math.round(1500 × 1.25)
  });

  it('FIXED · minFareCents acota por abajo: round(base×mult) < mínima ⇒ cobra la mínima', () => {
    // Política sintética (la base real nunca baja de 600 = banderazo, así que las mínimas del catálogo
    // no muerden con esta ruta): multiplier 0.1 → round(1500×0.1)=150 < minFare 300 → cobra 300.
    const clampPolicy: OfferingPricingPolicy = { multiplier: 0.1, minFareCents: 300 };
    const out = registry
      .forMode(PricingMode.FIXED)
      .resolveCreation({ ...baseInput, pricing: clampPolicy });
    expect(out.fareCents).toBe(300);
  });

  it('PUJA · IGNORA la política de la oferta: el bid ES la tarifa (el multiplier no toca el bid)', () => {
    const out = registry.forMode(PricingMode.PUJA).resolveCreation({
      ...baseInput,
      bidCents: 900,
      pricing: OFFERINGS[OfferingId.VEO_CONFORT].pricing, // ×1.25 NO se aplica al bid
    });
    expect(out).toEqual({ fareCents: 900, negotiationSeq: 1 });
  });
});
