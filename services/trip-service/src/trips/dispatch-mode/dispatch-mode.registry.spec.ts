/**
 * DispatchModeRegistry — la garantía OPEN/CLOSED: cada modo resuelve a su estrategia, y un modo SIN
 * estrategia registrada FALLA FUERTE (no cae silenciosamente en la rama PUJA, como pasaba con los
 * `if FIXED else PUJA` binarios antes del refactor).
 */
import { describe, it, expect } from 'vitest';
import { PricingMode } from '@veo/shared-types';
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
  const baseInput = { floorCents: 700, route, surge: 1, childMode: false };

  it('PUJA: el bid válido ES el fareCents y abre el ciclo (seq=1)', () => {
    const out = registry.forMode(PricingMode.PUJA).resolveCreation({ ...baseInput, bidCents: 1500 });
    expect(out).toEqual({ fareCents: 1500, negotiationSeq: 1 });
  });

  it('PUJA: sin bid → ValidationError', () => {
    expect(() => registry.forMode(PricingMode.PUJA).resolveCreation({ ...baseInput, bidCents: undefined })).toThrow();
  });

  it('PUJA: bid bajo el piso → ValidationError', () => {
    expect(() => registry.forMode(PricingMode.PUJA).resolveCreation({ ...baseInput, bidCents: 500 })).toThrow();
  });

  it('FIXED: ignora el bid, calcula por ruta y NO negocia (seq=0)', () => {
    const out = registry.forMode(PricingMode.FIXED).resolveCreation({ ...baseInput, bidCents: 99999 });
    expect(out.negotiationSeq).toBe(0);
    expect(out.fareCents).toBeGreaterThan(0); // tarifa por ruta, NO el bid
    expect(out.fareCents).not.toBe(99999);
  });
});
