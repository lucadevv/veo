/**
 * A2 (ADR-022 §P-A) · Netting de la deuda CASH del conductor contra su ganancia DIGITAL. El conductor cobró la
 * comisión de sus viajes en efectivo EN MANO → la debe; se descuenta de su payout digital (FIFO, más viejas
 * primero). Cubre deudas enteras mientras alcance; la del BORDE se REDUCE (queda PENDING → carry-forward), sin
 * partir la fila (respeta el UNIQUE(paymentId)). Verifica el flujo INVERSO del dinero.
 */
import { describe, it, expect, vi } from 'vitest';
import { PayoutsService } from './payouts.service';

type DebtRow = { id: string; amountCents: number };
type CreditRow = { id: string; amountCents: number };

/**
 * Fake REPO (ratings-spec style): los métodos tx-scoped IGNORAN el `tx` opaco y capturan/devuelven estado. El
 * CAS (status:PENDING + amountCents) + la data (SETTLED/APPLIED/settledInPayoutId/...) están cristalizados DENTRO
 * del repo real, así que el fake solo registra QUÉ deuda/crédito tocó el service y con qué payoutId/monto — la
 * MATEMÁTICA del netteo (lo que este spec prueba) sigue viviendo en el service.
 */
function makeRepo(debts: DebtRow[], credits: CreditRow[]) {
  const settled: { id: string; payoutId: string }[] = [];
  const reduced: { id: string; newAmountCents: number }[] = [];
  const creditsApplied: { id: string; payoutId: string }[] = [];
  const repo = {
    findPendingCreditsInTx: vi.fn(async () => credits),
    markCreditAppliedInTx: vi.fn(async (_tx: unknown, creditId: string, payoutId: string) => {
      creditsApplied.push({ id: creditId, payoutId });
    }),
    findPendingDebtsInTx: vi.fn(async () => debts),
    // Sin concurrencia el CAS siempre matchea → count:1.
    settleDebtInTx: vi.fn(
      async (_tx: unknown, debtId: string, _expected: number, payoutId: string) => {
        settled.push({ id: debtId, payoutId });
        return { count: 1 };
      },
    ),
    reduceDebtInTx: vi.fn(
      async (_tx: unknown, debtId: string, _expected: number, newAmountCents: number) => {
        reduced.push({ id: debtId, newAmountCents });
        return { count: 1 };
      },
    ),
  };
  return { repo, settled, reduced, creditsApplied };
}

function buildService(repo: unknown): PayoutsService {
  const config = { getOrThrow: (k: string) => (k === 'PAYOUT_MIN_CENTS' ? 0 : 500_000) };
  return new PayoutsService(repo as never, {} as never, {} as never, config as never);
}

// Acceso al método privado (misma técnica que otros specs del servicio): probamos la lógica REAL de netteo.
// El `tx` es opaco (el fake repo lo ignora): pasamos un objeto vacío.
const netting = (svc: PayoutsService, driverId: string, available: number, payoutId: string) =>
  (
    svc as unknown as {
      applyDebtNetting: (tx: unknown, d: string, a: number, p: string) => Promise<number>;
    }
  ).applyDebtNetting({}, driverId, available, payoutId);

describe('A2 · applyDebtNetting (netteo deuda CASH ⇄ ganancia digital)', () => {
  it('la ganancia CUBRE toda la deuda → settle TODO, el resto va al payout', async () => {
    const { repo, settled, reduced } = makeRepo(
      [
        { id: 'd1', amountCents: 300 },
        { id: 'd2', amountCents: 200 },
      ],
      [],
    );
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(500); // 300 + 200 → payout = 1000 − 500 = 500
    expect(reduced).toHaveLength(0); // ninguna del borde: ambas enteras
    expect(settled).toEqual([
      { id: 'd1', payoutId: 'pay-1' },
      { id: 'd2', payoutId: 'pay-1' },
    ]);
  });

  it('la ganancia < deuda → cubre la(s) entera(s) + REDUCE la del borde (carry-forward), payout 0', async () => {
    const { repo, settled, reduced } = makeRepo(
      [
        { id: 'd1', amountCents: 600 },
        { id: 'd2', amountCents: 600 },
      ],
      [],
    );
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(1000); // se aplican los 1000 disponibles → payout = 0
    expect(settled).toEqual([{ id: 'd1', payoutId: 'pay-1' }]); // deuda vieja cubierta entera (SETTLED)
    expect(reduced).toEqual([{ id: 'd2', newAmountCents: 200 }]); // 600 − 400; queda PENDING (carry-forward, no SETTLED)
  });

  it('deuda que EXCEDE por completo la ganancia → reduce la primera, payout 0, resto PENDING', async () => {
    const { repo, settled, reduced } = makeRepo([{ id: 'd1', amountCents: 1500 }], []);
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(1000);
    expect(settled).toHaveLength(0); // no se saldó entera
    expect(reduced).toEqual([{ id: 'd1', newAmountCents: 500 }]); // 1500 − 1000; sigue PENDING
  });

  it('sin deuda → aplica 0, ninguna actualización (payout = ganancia completa)', async () => {
    const { repo, settled, reduced } = makeRepo([], []);
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(0);
    expect(settled).toHaveLength(0);
    expect(reduced).toHaveLength(0);
  });

  // MEDIA #4 · credit-back: comisión CASH revertida cuya deuda ya se neteó (SETTLED) → DriverCredit que el payout SUMA.
  it('crédito PENDIENTE → se SUMA al neto (applied negativo) y se marca APPLIED ligado al payout', async () => {
    const { repo, settled, reduced, creditsApplied } = makeRepo([], [{ id: 'c1', amountCents: 400 }]);
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(-400); // crédito baja applied → netAmount = 1000 − (−400) = 1400
    expect(settled).toHaveLength(0); // sin deudas
    expect(reduced).toHaveLength(0);
    expect(creditsApplied).toEqual([{ id: 'c1', payoutId: 'pay-1' }]);
  });

  it('crédito + deuda: el crédito da MARGEN para netear la deuda entera este período', async () => {
    const { repo, settled, reduced } = makeRepo(
      [{ id: 'd1', amountCents: 1300 }],
      [{ id: 'c1', amountCents: 400 }],
    );
    const applied = await netting(buildService(repo), 'drv-1', 1000, 'pay-1');
    // crédito −400 + deuda 1300 = 900 → netAmount = 1000 − 900 = 100 (= ganancia 1000 − deuda 1300 + crédito 400).
    expect(applied).toBe(900);
    expect(settled).toEqual([{ id: 'd1', payoutId: 'pay-1' }]); // el margen del crédito alcanzó para saldarla entera
    expect(reduced).toHaveLength(0);
  });
});
