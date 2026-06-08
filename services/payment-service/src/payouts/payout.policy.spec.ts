import { describe, it, expect } from 'vitest';
import { aggregatePayouts, discrepancyPct, periodLabel } from './payout.policy';

describe('aggregatePayouts (BR-P05)', () => {
  it('agrega por conductor: neto = (bruto − comisión) + propinas', () => {
    const rows = [
      { driverId: 'd1', grossCents: 2000, commissionCents: 400, tipCents: 300 },
      { driverId: 'd1', grossCents: 3000, commissionCents: 600, tipCents: 0 },
    ];
    const [p] = aggregatePayouts(rows, 0);
    expect(p).toEqual({ driverId: 'd1', grossCents: 5000, commissionCents: 1000, amountCents: 4300 });
  });

  it('excluye conductores bajo el mínimo liquidable (S/50 = 5000)', () => {
    const rows = [
      { driverId: 'low', grossCents: 4000, commissionCents: 800, tipCents: 0 }, // neto 3200 < 5000
      { driverId: 'ok', grossCents: 8000, commissionCents: 1600, tipCents: 0 }, // neto 6400 >= 5000
    ];
    const result = aggregatePayouts(rows, 5000);
    expect(result.map((p) => p.driverId)).toEqual(['ok']);
  });

  it('es determinista (ordenado por driverId)', () => {
    const rows = [
      { driverId: 'b', grossCents: 10000, commissionCents: 2000, tipCents: 0 },
      { driverId: 'a', grossCents: 10000, commissionCents: 2000, tipCents: 0 },
    ];
    expect(aggregatePayouts(rows, 0).map((p) => p.driverId)).toEqual(['a', 'b']);
  });
});

describe('discrepancyPct (BR-P07)', () => {
  it('0% cuando DB y extracto coinciden', () => {
    expect(discrepancyPct(100000, 100000)).toBe(0);
  });

  it('calcula la fracción de diferencia', () => {
    expect(discrepancyPct(100000, 99000)).toBeCloseTo(0.01, 5);
    expect(discrepancyPct(100000, 98000)).toBeCloseTo(0.02, 5);
  });

  it('ambos en cero → 0', () => {
    expect(discrepancyPct(0, 0)).toBe(0);
  });
});

describe('periodLabel', () => {
  it('formatea YYYY-MM-DD/YYYY-MM-DD', () => {
    expect(periodLabel(new Date('2026-05-18T00:00:00Z'), new Date('2026-05-25T00:00:00Z'))).toBe(
      '2026-05-18/2026-05-25',
    );
  });
});
