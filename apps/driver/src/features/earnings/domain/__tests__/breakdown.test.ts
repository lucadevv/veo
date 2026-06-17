import type { DriverEarningsBreakdown, DriverEarningsSummary } from '@veo/api-client';
import {
  breakdownLines,
  commissionRate,
  expectedNetCents,
  isBreakdownConsistent,
  weekNetCents,
} from '../value-objects/breakdown';

function period(p: Partial<DriverEarningsBreakdown> = {}): DriverEarningsBreakdown {
  return {
    grossCents: p.grossCents ?? 10000,
    commissionCents: p.commissionCents ?? 2000,
    tipCents: p.tipCents ?? 500,
    netCents: p.netCents ?? 8500,
    tripCount: p.tripCount ?? 7,
  };
}

describe('earnings breakdown value-object', () => {
  it('expectedNetCents = bruto − comisión + propinas', () => {
    expect(expectedNetCents(period())).toBe(8500);
    expect(
      expectedNetCents(period({ grossCents: 20000, commissionCents: 5000, tipCents: 1000 })),
    ).toBe(16000);
  });

  it('isBreakdownConsistent detecta netos coherentes e incoherentes', () => {
    expect(isBreakdownConsistent(period())).toBe(true);
    expect(isBreakdownConsistent(period({ netCents: 9999 }))).toBe(false);
  });

  it('commissionRate es la fracción del bruto y 0 cuando no hay bruto', () => {
    expect(commissionRate(period({ grossCents: 10000, commissionCents: 2000 }))).toBeCloseTo(0.2);
    expect(commissionRate(period({ grossCents: 0, commissionCents: 0, netCents: 0 }))).toBe(0);
  });

  it('breakdownLines respeta el orden de lectura bruto→comisión→propinas→neto', () => {
    const lines = breakdownLines(period());
    expect(lines.map((l) => l.key)).toEqual(['gross', 'commission', 'tips', 'net']);
    expect(lines.map((l) => l.cents)).toEqual([10000, 2000, 500, 8500]);
  });

  it('weekNetCents devuelve el neto del período semanal del summary', () => {
    const summary: DriverEarningsSummary = {
      driverId: 'd-1',
      currency: 'PEN',
      today: period({ netCents: 8500 }),
      week: period({ grossCents: 50000, commissionCents: 10000, tipCents: 2500, netCents: 42500 }),
    };
    expect(weekNetCents(summary)).toBe(42500);
  });
});
