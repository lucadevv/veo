/**
 * A2 (ADR-022 §P-A) · Netting de la deuda CASH del conductor contra su ganancia DIGITAL. El conductor cobró la
 * comisión de sus viajes en efectivo EN MANO → la debe; se descuenta de su payout digital (FIFO, más viejas
 * primero). Cubre deudas enteras mientras alcance; la del BORDE se REDUCE (queda PENDING → carry-forward), sin
 * partir la fila (respeta el UNIQUE(paymentId)). Verifica el flujo INVERSO del dinero.
 */
import { describe, it, expect, vi } from 'vitest';
import { PayoutsService } from './payouts.service';

type DebtRow = { id: string; amountCents: number };

function buildService(): PayoutsService {
  const config = { getOrThrow: (k: string) => (k === 'PAYOUT_MIN_CENTS' ? 0 : 500_000) };
  return new PayoutsService({} as never, {} as never, {} as never, config as never);
}

function mockTx(debts: DebtRow[]) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const tx = {
    driverDebt: {
      findMany: vi.fn(async () => debts),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return { ...where, ...data };
      }),
    },
  };
  return { tx, updates };
}

// Acceso al método privado (misma técnica que otros specs del servicio): probamos la lógica REAL de netteo.
const netting = (svc: PayoutsService, tx: unknown, driverId: string, available: number, payoutId: string) =>
  (svc as unknown as {
    applyDebtNetting: (tx: unknown, d: string, a: number, p: string) => Promise<number>;
  }).applyDebtNetting(tx, driverId, available, payoutId);

describe('A2 · applyDebtNetting (netteo deuda CASH ⇄ ganancia digital)', () => {
  it('la ganancia CUBRE toda la deuda → settle TODO, el resto va al payout', async () => {
    const svc = buildService();
    const { tx, updates } = mockTx([
      { id: 'd1', amountCents: 300 },
      { id: 'd2', amountCents: 200 },
    ]);
    const applied = await netting(svc, tx, 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(500); // 300 + 200 → payout = 1000 − 500 = 500
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.data.status === 'SETTLED' && u.data.settledInPayoutId === 'pay-1')).toBe(true);
  });

  it('la ganancia < deuda → cubre la(s) entera(s) + REDUCE la del borde (carry-forward), payout 0', async () => {
    const svc = buildService();
    const { tx, updates } = mockTx([
      { id: 'd1', amountCents: 600 },
      { id: 'd2', amountCents: 600 },
    ]);
    const applied = await netting(svc, tx, 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(1000); // se aplican los 1000 disponibles → payout = 0
    const d1 = updates.find((u) => u.id === 'd1')!;
    const d2 = updates.find((u) => u.id === 'd2')!;
    expect(d1.data.status).toBe('SETTLED'); // deuda vieja cubierta entera
    expect(d2.data.amountCents).toBe(200); // 600 − 400 aplicados; queda PENDING (carry-forward)
    expect(d2.data.status).toBeUndefined(); // NO se marca SETTLED: solo se redujo el monto
  });

  it('deuda que EXCEDE por completo la ganancia → reduce la primera, payout 0, resto PENDING', async () => {
    const svc = buildService();
    const { tx, updates } = mockTx([{ id: 'd1', amountCents: 1500 }]);
    const applied = await netting(svc, tx, 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(1000);
    expect(updates[0]!.data.amountCents).toBe(500); // 1500 − 1000; sigue PENDING
    expect(updates[0]!.data.status).toBeUndefined();
  });

  it('sin deuda → aplica 0, ninguna actualización (payout = ganancia completa)', async () => {
    const svc = buildService();
    const { tx, updates } = mockTx([]);
    const applied = await netting(svc, tx, 'drv-1', 1000, 'pay-1');
    expect(applied).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
