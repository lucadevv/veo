/**
 * A2 (ADR-022 §P-A) · Acumulación de la deuda CASH: cuando un cobro en EFECTIVO CAPTURA (confirmación bilateral),
 * el conductor cobró la comisión EN MANO → la DEBE a la plataforma. Se crea un `DriverDebt` = commissionCents
 * DENTRO de la misma tx de captura (atomicidad captura ⇔ deuda). Carpooling (comisión 0, conductor 100%) NO acumula.
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';

// enqueueOutbox se stubea: la captura emite payment.captured en la misma tx, pero acá probamos la DEUDA.
vi.mock('@veo/database', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, enqueueOutbox: vi.fn(async () => {}) };
});

type Row = Record<string, unknown>;

function buildService() {
  const created: Row[] = [];
  const prisma = {
    write: {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          payment: { updateMany: vi.fn(async () => ({ count: 1 })) }, // la captura gana el CAS
          driverDebt: {
            create: vi.fn(async ({ data }: { data: Row }) => {
              created.push(data);
              return { ...data };
            }),
          },
        }),
      ),
    },
  };
  const svc = new PaymentsService(
    prisma as never, {} as never, {} as never, {} as never, { getOrThrow: () => 0 } as never,
  );
  return { svc, created };
}

const captureCash = (svc: PaymentsService, payment: Row) =>
  (svc as unknown as { captureCash: (p: Row) => Promise<void> }).captureCash(payment);

describe('A2 · captureCash acumula la deuda CASH del conductor', () => {
  it('viaje CASH con comisión → crea DriverDebt = commissionCents (PENDING, reason CASH_COMMISSION)', async () => {
    const { svc, created } = buildService();
    await captureCash(svc, {
      id: 'pay-cash', tripId: 'trip-1', method: 'CASH', driverId: 'drv-1', passengerId: 'pax-1',
      grossCents: 2000, commissionCents: 400, currency: 'PEN', status: 'PENDING',
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.amountCents).toBe(400); // = la comisión que el conductor cobró EN MANO
    expect(created[0]!.driverId).toBe('drv-1');
    expect(created[0]!.paymentId).toBe('pay-cash'); // idempotencia por cobro
    expect(created[0]!.status).toBe('PENDING');
    expect(created[0]!.reason).toBe('CASH_COMMISSION');
  });

  it('viaje CASH SIN comisión (carpooling 100% al conductor) → NO acumula deuda', async () => {
    const { svc, created } = buildService();
    await captureCash(svc, {
      id: 'pay-cp', tripId: 'trip-2', method: 'CASH', driverId: 'drv-1',
      grossCents: 2000, commissionCents: 0, currency: 'PEN', status: 'PENDING',
    });
    expect(created).toHaveLength(0);
  });
});

/**
 * A2 (gate) · Al reembolsar un cobro CASH, la deuda de comisión se REVIERTE — si no, el conductor queda
 * sobre-cobrado la comisión de un viaje que no ocurrió (el netting se la cobraría igual de su ganancia digital).
 */
function svcOnly(): PaymentsService {
  return new PaymentsService(
    {} as never, {} as never, {} as never, {} as never, { getOrThrow: () => 0 } as never,
  );
}
function debtTx(debt: Row | null) {
  const updates: Row[] = [];
  const credits: Row[] = [];
  const tx = {
    driverDebt: {
      findUnique: vi.fn(async () => debt),
      update: vi.fn(async ({ data }: { data: Row }) => {
        updates.push(data);
        return { ...(debt ?? {}), ...data };
      }),
    },
    driverCredit: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        credits.push(data);
        return data;
      }),
    },
  };
  return { tx, updates, credits };
}
const reverse = (svc: PaymentsService, tx: unknown, pid: string, amt: number) =>
  (svc as unknown as {
    reverseCashDebtInTx: (tx: unknown, pid: string, amt: number) => Promise<void>;
  }).reverseCashDebtInTx(tx, pid, amt);

describe('A2 · refund CASH revierte la deuda de comisión', () => {
  it('full refund → deuda REVERSED (el conductor ya no debe la comisión del viaje revertido)', async () => {
    const { tx, updates } = debtTx({ id: 'dd1', amountCents: 400, status: 'PENDING' });
    await reverse(svcOnly(), tx, 'pay-cash', 2000); // refund del bruto completo > comisión → a 0
    expect(updates[0]!.status).toBe('REVERSED');
    expect(updates[0]!.amountCents).toBe(0);
  });

  it('partial refund → deuda REDUCIDA (la plataforma absorbe el refund de su comisión), sigue PENDING', async () => {
    const { tx, updates } = debtTx({ id: 'dd1', amountCents: 400, status: 'PENDING' });
    await reverse(svcOnly(), tx, 'pay-cash', 100);
    expect(updates[0]!.amountCents).toBe(300); // 400 − 100
    expect(updates[0]!.status).toBeUndefined(); // sigue PENDING
  });

  it('deuda ya SETTLED (neteada en un payout) → ACREDITA al conductor (credit-back) + deuda REVERSED', async () => {
    const { tx, updates, credits } = debtTx({
      id: 'dd1',
      driverId: 'drv-1',
      tripId: 'trip-1',
      amountCents: 400,
      status: 'SETTLED',
    });
    await reverse(svcOnly(), tx, 'pay-cash', 2000); // refund del bruto > comisión → acredita los 400 completos
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amountCents).toBe(400); // min(400, 2000) = la comisión que ya pagó
    expect(credits[0]!.sourcePaymentId).toBe('pay-cash'); // idempotencia por cobro
    expect(credits[0]!.status).toBe('PENDING');
    expect(updates[0]!.status).toBe('REVERSED'); // la deuda queda REVERSED (traza; el monto lo lleva el crédito)
  });

  it('deuda ya REVERSED (refund re-entregado / 2do refund) → no-op idempotente (ni crédito ni update)', async () => {
    const { tx, updates, credits } = debtTx({
      id: 'dd1',
      driverId: 'drv-1',
      tripId: 'trip-1',
      amountCents: 400,
      status: 'REVERSED',
    });
    await reverse(svcOnly(), tx, 'pay-cash', 2000);
    expect(credits).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('sin deuda (viaje sin comisión / carpooling) → no-op', async () => {
    const { tx, updates } = debtTx(null);
    await reverse(svcOnly(), tx, 'pay-cash', 2000);
    expect(updates).toHaveLength(0);
  });
});
