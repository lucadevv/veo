/**
 * A2 (ADR-022 §P-A) · Acumulación de la deuda CASH: cuando un cobro en EFECTIVO CAPTURA (confirmación bilateral),
 * el conductor cobró la comisión EN MANO → la DEBE a la plataforma. Se crea un `DriverDebt` = commissionCents
 * DENTRO de la misma tx de captura (atomicidad captura ⇔ deuda). Carpooling (comisión 0, conductor 100%) NO acumula.
 */
import { describe, it, expect } from 'vitest';
import { PaymentsService } from './payments.service';

type Row = Record<string, unknown>;

function buildService() {
  const created: Row[] = [];
  // Mock del PaymentsRepository: captureCash gana el CAS (count 1) y acumula la deuda vía createDriverDebtInTx.
  // La emisión del outbox (payment.captured) la absorbe el fake de enqueueOutbox; acá probamos la DEUDA.
  const repo = {
    runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
    casCaptureCash: async () => ({ count: 1 }),
    createDriverDebtInTx: async (_tx: unknown, data: Row) => {
      created.push(data);
      return { ...data };
    },
    // ADR-022 §P-A · captureCash ahora consulta el total PENDING tras acumular la deuda para evaluar el cruce del
    // tope (maybeEmitDebtExceeded). Con cap=0 (config mock) devolver solo la deuda recién creada basta: el cruce lo
    // absorbe enqueueOutbox (no-op); acá probamos SOLO que se acumula la DEUDA.
    findPendingDebtsByDriverInTx: async () => created,
    enqueueOutbox: async () => {},
  };
  const svc = new PaymentsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    { getOrThrow: () => 0 } as never,
  );
  return { svc, created };
}

const captureCash = (svc: PaymentsService, payment: Row) =>
  (svc as unknown as { captureCash: (p: Row) => Promise<void> }).captureCash(payment);

describe('A2 · captureCash acumula la deuda CASH del conductor', () => {
  it('viaje CASH con comisión → crea DriverDebt = commissionCents (PENDING, reason CASH_COMMISSION)', async () => {
    const { svc, created } = buildService();
    await captureCash(svc, {
      id: 'pay-cash',
      tripId: 'trip-1',
      method: 'CASH',
      driverId: 'drv-1',
      passengerId: 'pax-1',
      grossCents: 2000,
      commissionCents: 400,
      currency: 'PEN',
      status: 'PENDING',
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
      id: 'pay-cp',
      tripId: 'trip-2',
      method: 'CASH',
      driverId: 'drv-1',
      grossCents: 2000,
      commissionCents: 0,
      currency: 'PEN',
      status: 'PENDING',
    });
    expect(created).toHaveLength(0);
  });
});

/**
 * A2 (gate) · Al reembolsar un cobro CASH, la deuda de comisión se REVIERTE — si no, el conductor queda
 * sobre-cobrado la comisión de un viaje que no ocurrió (el netting se la cobraría igual de su ganancia digital).
 */
/**
 * Repo fake para reverseCashDebtInTx: las lecturas/escrituras de la deuda pasan por métodos tx-scoped del repo
 * (findDriverDebtByPaymentInTx / updateDriverDebtInTx / createDriverCreditInTx). El `tx` es un handle ficticio.
 */
function debtRepo(debt: Row | null) {
  const updates: Row[] = [];
  const credits: Row[] = [];
  const repo = {
    findDriverDebtByPaymentInTx: async () => debt,
    updateDriverDebtInTx: async (_tx: unknown, _id: string, data: Row) => {
      updates.push(data);
      return { ...(debt ?? {}), ...data };
    },
    createDriverCreditInTx: async (_tx: unknown, data: Row) => {
      credits.push(data);
      return data;
    },
  };
  const svc = new PaymentsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    { getOrThrow: () => 0 } as never,
  );
  return { svc, updates, credits };
}
const reverse = (svc: PaymentsService, pid: string, amt: number, gross: number) =>
  (
    svc as unknown as {
      reverseCashDebtInTx: (tx: unknown, pid: string, amt: number, gross: number) => Promise<void>;
    }
  ).reverseCashDebtInTx({}, pid, amt, gross);

describe('A2 · refund CASH revierte la deuda de comisión (proporcional al bruto)', () => {
  it('full refund → deuda REVERSED (el conductor ya no debe la comisión del viaje revertido)', async () => {
    const { svc, updates } = debtRepo({ id: 'dd1', amountCents: 400, status: 'PENDING' });
    await reverse(svc, 'pay-cash', 2000, 2000); // refund del bruto ENTERO → revierte la comisión entera
    expect(updates[0]!.status).toBe('REVERSED');
    expect(updates[0]!.amountCents).toBe(0);
  });

  it('partial refund → comisión revertida PROPORCIONAL (round(deuda·refund/gross)), deuda sigue PENDING', async () => {
    const { svc, updates } = debtRepo({ id: 'dd1', amountCents: 400, status: 'PENDING' });
    await reverse(svc, 'pay-cash', 1000, 2000); // se reembolsa la MITAD (1000 de 2000)
    expect(updates[0]!.amountCents).toBe(200); // 400 − round(400·1000/2000)=400−200 (antes, con el bug: 300)
    expect(updates[0]!.status).toBeUndefined(); // sigue PENDING (el conductor debe la comisión de la mitad servida)
  });

  it('deuda ya SETTLED (neteada en un payout) → ACREDITA al conductor (credit-back) + deuda REVERSED', async () => {
    const { svc, updates, credits } = debtRepo({
      id: 'dd1',
      driverId: 'drv-1',
      tripId: 'trip-1',
      amountCents: 400,
      status: 'SETTLED',
    });
    await reverse(svc, 'pay-cash', 2000, 2000); // refund del bruto ENTERO → acredita los 400 completos
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amountCents).toBe(400); // min(400, 2000) = la comisión que ya pagó
    expect(credits[0]!.sourcePaymentId).toBe('pay-cash'); // idempotencia por cobro
    expect(credits[0]!.status).toBe('PENDING');
    expect(updates[0]!.status).toBe('REVERSED'); // la deuda queda REVERSED (traza; el monto lo lleva el crédito)
  });

  it('deuda ya REVERSED (refund re-entregado / 2do refund) → no-op idempotente (ni crédito ni update)', async () => {
    const { svc, updates, credits } = debtRepo({
      id: 'dd1',
      driverId: 'drv-1',
      tripId: 'trip-1',
      amountCents: 400,
      status: 'REVERSED',
    });
    await reverse(svc, 'pay-cash', 2000, 2000);
    expect(credits).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('sin deuda (viaje sin comisión / carpooling) → no-op', async () => {
    const { svc, updates } = debtRepo(null);
    await reverse(svc, 'pay-cash', 2000, 2000);
    expect(updates).toHaveLength(0);
  });
});
