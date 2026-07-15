/**
 * PayoutsService.getDriverPendingBalance — balance pendiente del conductor para el riel driver.
 * Lo crítico a fijar:
 *  - `openNetCents` = gross − commission + tips del devengado DIGITAL posterior al último período agregado
 *    en Payout; si NUNCA hubo payout, el agregado corre SIN borde inferior (desde siempre).
 *  - El borde inferior es el `periodEnd` del último payout (cualquier estado: la fila existe ⇒ ya se agregó).
 *  - `pendingDebtCents`/`pendingCreditCents` = los agregados PENDING tal cual (lo que el próximo netting
 *    va a descontar/sumar).
 * READ puro (sin mutación de dinero) → unit con fake repo, mismo criterio que payouts.stats.spec.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { PayoutsService } from './payouts.service';

interface Sums {
  grossCents: number;
  commissionCents: number;
  tipCents: number;
}

function makeService(opts: {
  lastPeriodEnd: Date | null;
  earned: Sums;
  debtCents?: number;
  creditCents?: number;
}) {
  const repo = {
    findLatestPayoutPeriodEnd: vi.fn(async () => opts.lastPeriodEnd),
    aggregateDriverCapturedNonCashSince: vi.fn(async () => opts.earned),
    sumPendingDebtCentsForDriver: vi.fn(async () => opts.debtCents ?? 0),
    sumPendingCreditCentsForDriver: vi.fn(async () => opts.creditCents ?? 0),
  };
  const config = { getOrThrow: (k: string) => (k === 'PAYOUT_MIN_CENTS' ? 0 : 500_000) };
  const svc = new PayoutsService(repo as never, {} as never, {} as never, config as never);
  return { svc, repo };
}

describe('PayoutsService.getDriverPendingBalance (riel driver)', () => {
  it('sin payouts previos: agrega el devengado digital DESDE SIEMPRE (from null)', async () => {
    const { svc, repo } = makeService({
      lastPeriodEnd: null,
      earned: { grossCents: 20_000, commissionCents: 2_400, tipCents: 1_100 },
    });
    const out = await svc.getDriverPendingBalance('drv-1');
    expect(out.openNetCents).toBe(20_000 - 2_400 + 1_100);
    expect(repo.aggregateDriverCapturedNonCashSince).toHaveBeenCalledWith('drv-1', null);
  });

  it('con payout previo: el período abierto arranca en el periodEnd del último payout agregado', async () => {
    const lastEnd = new Date('2026-07-06T00:00:00.000Z');
    const { svc, repo } = makeService({
      lastPeriodEnd: lastEnd,
      earned: { grossCents: 18_700, commissionCents: 0, tipCents: 0 },
    });
    const out = await svc.getDriverPendingBalance('drv-1');
    expect(out.openNetCents).toBe(18_700);
    expect(repo.aggregateDriverCapturedNonCashSince).toHaveBeenCalledWith('drv-1', lastEnd);
  });

  it('expone la deuda y el crédito PENDING tal cual (lo que el próximo netting descuenta/suma)', async () => {
    const { svc } = makeService({
      lastPeriodEnd: null,
      earned: { grossCents: 0, commissionCents: 0, tipCents: 0 },
      debtCents: 804, // S/8.04 de comisión CASH adeudada
      creditCents: 150,
    });
    const out = await svc.getDriverPendingBalance('drv-1');
    expect(out).toEqual({ openNetCents: 0, pendingDebtCents: 804, pendingCreditCents: 150 });
  });

  it('semana abierta SIN cobros: todo en 0 (agregados vacíos → 0, no null)', async () => {
    const { svc } = makeService({
      lastPeriodEnd: new Date('2026-07-06T00:00:00.000Z'),
      earned: { grossCents: 0, commissionCents: 0, tipCents: 0 },
    });
    const out = await svc.getDriverPendingBalance('drv-1');
    expect(out.openNetCents).toBe(0);
    expect(out.pendingDebtCents).toBe(0);
    expect(out.pendingCreditCents).toBe(0);
  });
});
