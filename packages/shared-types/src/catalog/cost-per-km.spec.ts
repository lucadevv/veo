import { describe, it, expect } from 'vitest';
import { deriveCostPerKmCents, CARPOOLING_COST_REFERENCE } from './cost-per-km.js';
import { OFFERINGS, OfferingId } from './offerings.js';
import { EnergySource } from '../enums/index.js';

describe('deriveCostPerKmCents · FUENTE ÚNICA de la fórmula (F2.5)', () => {
  it('precio ÷ rendimiento, redondeado a céntimo entero', () => {
    // 500 céntimos/L ÷ 12 km/L = 41.67 → round 42.
    expect(deriveCostPerKmCents(500, 12)).toBe(42);
    // 480 ÷ 40 = 12 exacto (moto).
    expect(deriveCostPerKmCents(480, 40)).toBe(12);
  });

  it('redondea HALF-UP como Math.round (consistencia con el deriveFuelPerKmCents histórico)', () => {
    // 25 ÷ 10 = 2.5 → 3.
    expect(deriveCostPerKmCents(25, 10)).toBe(3);
  });

  it('rendimiento ≤ 0 → 0 (NUNCA división por cero ni Infinity)', () => {
    expect(deriveCostPerKmCents(500, 0)).toBe(0);
    expect(deriveCostPerKmCents(500, -12)).toBe(0);
  });

  it('precio < 0 → 0', () => {
    expect(deriveCostPerKmCents(-1, 12)).toBe(0);
  });

  it('entradas no-finitas (NaN/Infinity) → 0 (degradación honesta, sin NaN al precio)', () => {
    expect(deriveCostPerKmCents(Number.NaN, 12)).toBe(0);
    expect(deriveCostPerKmCents(500, Number.NaN)).toBe(0);
    expect(deriveCostPerKmCents(Number.POSITIVE_INFINITY, 12)).toBe(0);
    expect(deriveCostPerKmCents(500, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('precio 0 → 0 (energía gratis = costo/km 0, no degeneración)', () => {
    expect(deriveCostPerKmCents(0, 12)).toBe(0);
  });
});

describe('CARPOOLING_COST_REFERENCE · derivada del catálogo (no diverge)', () => {
  it('= VEO_ECONÓMICO (GASOLINE_90, 12 km/L) tomado de OFFERINGS', () => {
    expect(CARPOOLING_COST_REFERENCE.energySource).toBe(EnergySource.GASOLINE_90);
    expect(CARPOOLING_COST_REFERENCE.efficiencyKmPerUnit).toBe(12);
  });

  it('sigue al catálogo: es exactamente el referenceEnergySourceId/Efficiency del económico', () => {
    const economico = OFFERINGS[OfferingId.VEO_ECONOMICO];
    expect(CARPOOLING_COST_REFERENCE.energySource).toBe(economico.referenceEnergySourceId);
    expect(CARPOOLING_COST_REFERENCE.efficiencyKmPerUnit).toBe(economico.referenceEfficiency);
  });
});
