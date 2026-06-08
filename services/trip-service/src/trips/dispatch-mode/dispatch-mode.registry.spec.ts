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
