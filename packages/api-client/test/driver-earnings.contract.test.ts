import { describe, expect, it } from 'vitest';
import { driverEarningsBreakdown, driverPayoutView, earningsSummary } from '../src/mobile.js';

/**
 * Test de contrato del riel de ganancias del CONDUCTOR (dock "Por liquidar" honesto):
 *  - `driverPayoutView.debtAppliedCents` (neteo firmado) debe SOBREVIVIR el parse zod — antes el schema
 *    lo strippeaba y el app no podía explicar por qué gross − comisión ≠ monto.
 *  - `earningsSummary.openNetCents`/`pendingDebtCents` y el split cash/digital del breakdown son
 *    ADDITIVE (opcionales): un BFF viejo sin los campos sigue parseando.
 */
describe('contrato de ganancias del conductor · dinero honesto', () => {
  const basePayout = {
    id: 'pay-1',
    driverId: 'drv-1',
    periodStart: '2026-07-06T00:00:00.000Z',
    periodEnd: '2026-07-13T00:00:00.000Z',
    grossCents: 10_000,
    commissionCents: 2_000,
    amountCents: 7_196, // 8000 − 804 de deuda neteada
    currency: 'PEN',
    status: 'PROCESSED',
    processedAt: '2026-07-13T12:00:00.000Z',
    heldReason: null,
    createdAt: '2026-07-13T06:00:00.000Z',
    updatedAt: '2026-07-13T12:00:00.000Z',
  };

  it('driverPayoutView conserva debtAppliedCents (zod no lo strippea)', () => {
    const parsed = driverPayoutView.parse({ ...basePayout, debtAppliedCents: 804 });
    expect(parsed.debtAppliedCents).toBe(804);
  });

  it('driverPayoutView sigue parseando SIN debtAppliedCents (additive, BFF viejo)', () => {
    const parsed = driverPayoutView.parse(basePayout);
    expect(parsed.debtAppliedCents).toBeUndefined();
  });

  it('earningsSummary conserva openNetCents y pendingDebtCents', () => {
    const parsed = earningsSummary.parse({
      driverId: 'drv-1',
      currency: 'PEN',
      payoutCount: 0,
      totalGrossCents: 0,
      totalCommissionCents: 0,
      totalNetCents: 0,
      paidNetCents: 0,
      pendingNetCents: 17_896,
      openNetCents: 18_700,
      pendingDebtCents: 804,
      payouts: [],
    });
    expect(parsed.openNetCents).toBe(18_700);
    expect(parsed.pendingDebtCents).toBe(804);
  });

  it('driverEarningsBreakdown conserva el split cash/digital (y es opcional)', () => {
    const withSplit = driverEarningsBreakdown.parse({
      grossCents: 5_000,
      commissionCents: 1_000,
      tipCents: 300,
      netCents: 4_300,
      cashNetCents: 2_400,
      digitalNetCents: 1_900,
      tripCount: 2,
    });
    expect(withSplit.cashNetCents).toBe(2_400);
    expect(withSplit.digitalNetCents).toBe(1_900);

    const legacy = driverEarningsBreakdown.parse({
      grossCents: 5_000,
      commissionCents: 1_000,
      tipCents: 300,
      netCents: 4_300,
      tripCount: 2,
    });
    expect(legacy.cashNetCents).toBeUndefined();
  });

  it('el dinero es Int céntimos: rechaza un debtAppliedCents decimal', () => {
    expect(() => driverPayoutView.parse({ ...basePayout, debtAppliedCents: 8.04 })).toThrow();
  });
});
