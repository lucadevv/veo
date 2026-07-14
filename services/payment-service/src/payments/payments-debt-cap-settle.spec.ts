/**
 * ADR-022 §P-A · TOPE de deuda CASH + LIQUIDACIÓN por el rail. Reglas de negocio (regla 7):
 *   1. Al CRUZAR el tope (previo ≤ tope < nuevo) captureCash emite `driver.debt_exceeded` UNA sola vez.
 *   2. Si ya estaba POR ENCIMA del tope → NO re-emite (el cruce ya ocurrió en un viaje anterior).
 *   3. Bajo el tope → NO emite.
 *   4. Al capturar la liquidación, se marcan las deudas PENDING → PAID (FIFO) y se emite `driver.debt_cleared`.
 *   5. Una deuda ACUMULADA tras crear la liquidación (createdAt posterior) NO se marca (el FIFO se corta).
 *   6. settleDriverDebt: sin deuda → 409; idempotente (una liquidación PENDING en curso → devuelve la misma).
 */
import { describe, it, expect } from 'vitest';
import { PaymentsService } from './payments.service';

type Row = Record<string, unknown>;

/** Config mock: DRIVER_DEBT_CAP_CENTS configurable; el resto de las claves numéricas → 0; método → CASH. */
function config(capCents: number) {
  return {
    getOrThrow: (key: string) => {
      if (key === 'DRIVER_DEBT_CAP_CENTS') return capCents;
      if (key === 'DEFAULT_PAYMENT_METHOD') return 'CASH';
      return 0;
    },
  };
}

// ── 1-3 · cruce del tope en captureCash ───────────────────────────────────────────────────────────
function buildForCapture(capCents: number, pendingAfter: Row[]) {
  const outbox: Row[] = [];
  const repo = {
    runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
    casCaptureCash: async () => ({ count: 1 }),
    createDriverDebtInTx: async (_tx: unknown, data: Row) => ({ ...data }),
    // El estado PENDING tras acumular la deuda de este viaje (incluye la recién creada) lo controla el test.
    findPendingDebtsByDriverInTx: async () => pendingAfter,
    enqueueOutbox: async (_tx: unknown, envelope: Row) => {
      outbox.push(envelope);
    },
  };
  const svc = new PaymentsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    config(capCents) as never,
  );
  return { svc, outbox };
}

const captureCash = (svc: PaymentsService, payment: Row) =>
  (svc as unknown as { captureCash: (p: Row) => Promise<void> }).captureCash(payment);

const debtExceeded = (outbox: Row[]) =>
  outbox.filter((e) => e.eventType === 'driver.debt_exceeded');

const basePayment: Row = {
  id: 'pay-1',
  tripId: 'trip-1',
  method: 'CASH',
  driverId: 'drv-1',
  passengerId: 'pax-1',
  grossCents: 2000,
  commissionCents: 400,
  currency: 'PEN',
  status: 'PENDING',
};

describe('ADR-022 §P-A · captureCash emite driver.debt_exceeded al CRUZAR el tope', () => {
  it('cruza el tope (previo 9800 ≤ 10000 < 10200 nuevo) → emite UNA vez con total+threshold', async () => {
    const pendingAfter = [
      { amountCents: 9800, createdAt: new Date('2026-07-10') },
      { amountCents: 400, createdAt: new Date('2026-07-14') }, // la recién acumulada (más nueva)
    ];
    const { svc, outbox } = buildForCapture(10000, pendingAfter);
    await captureCash(svc, basePayment);
    const emitted = debtExceeded(outbox);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      driverId: 'drv-1',
      totalDebtCents: 10200,
      thresholdCents: 10000,
    });
  });

  it('ya estaba POR ENCIMA (previo 10500 > 10000) → NO re-emite', async () => {
    const pendingAfter = [
      { amountCents: 10500, createdAt: new Date('2026-07-10') },
      { amountCents: 400, createdAt: new Date('2026-07-14') },
    ];
    const { svc, outbox } = buildForCapture(10000, pendingAfter);
    await captureCash(svc, basePayment);
    expect(debtExceeded(outbox)).toHaveLength(0);
  });

  it('bajo el tope (total 400 < 10000) → NO emite', async () => {
    const pendingAfter = [{ amountCents: 400, createdAt: new Date('2026-07-14') }];
    const { svc, outbox } = buildForCapture(10000, pendingAfter);
    await captureCash(svc, basePayment);
    expect(debtExceeded(outbox)).toHaveLength(0);
  });

  it('viaje CASH SIN comisión (carpooling) → ni deuda ni evaluación de cruce', async () => {
    const { svc, outbox } = buildForCapture(0, []); // cap 0: cualquier deuda cruzaría, pero no hay comisión
    await captureCash(svc, { ...basePayment, commissionCents: 0 });
    expect(debtExceeded(outbox)).toHaveLength(0);
  });
});

// ── 4-5 · captura de la liquidación marca PAID (FIFO) + emite driver.debt_cleared ───────────────────
function buildForSettleCapture(pending: Row[]) {
  const paid: Row[] = [];
  const outbox: Row[] = [];
  const repo = {
    findPendingDebtsByDriverInTx: async () => pending,
    markDriverDebtPaidInTx: async (
      _tx: unknown,
      id: string,
      amountCents: number,
      settlementPaymentId: string,
    ) => {
      paid.push({ id, amountCents, settlementPaymentId });
      return { count: 1 };
    },
    enqueueOutbox: async (_tx: unknown, envelope: Row) => {
      outbox.push(envelope);
    },
  };
  const svc = new PaymentsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    config(10000) as never,
  );
  return { svc, paid, outbox };
}

const settleDebtsOnCapture = (svc: PaymentsService, payment: Row) =>
  (
    svc as unknown as { settleDebtsOnCapture: (tx: unknown, p: Row) => Promise<void> }
  ).settleDebtsOnCapture({}, payment);

describe('ADR-022 §P-A · captura de la liquidación marca PAID (FIFO) + emite driver.debt_cleared', () => {
  it('cubre EXACTO las deudas del snapshot → todas PAID + un driver.debt_cleared', async () => {
    const pending = [
      { id: 'd1', amountCents: 6000, createdAt: new Date('2026-07-10') },
      { id: 'd2', amountCents: 4200, createdAt: new Date('2026-07-12') },
    ];
    const { svc, paid, outbox } = buildForSettleCapture(pending);
    await settleDebtsOnCapture(svc, {
      id: 'pay-settle',
      amountCents: 10200,
      debtSettlementDriverId: 'drv-1',
    });
    expect(paid.map((p) => p.id)).toEqual(['d1', 'd2']);
    expect(paid.every((p) => p.settlementPaymentId === 'pay-settle')).toBe(true);
    const cleared = outbox.filter((e) => e.eventType === 'driver.debt_cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.payload).toMatchObject({ driverId: 'drv-1' });
  });

  it('una deuda NUEVA acumulada tras la liquidación (createdAt posterior) NO se marca (FIFO se corta)', async () => {
    const pending = [
      { id: 'd1', amountCents: 6000, createdAt: new Date('2026-07-10') },
      { id: 'd2', amountCents: 4200, createdAt: new Date('2026-07-12') },
      { id: 'd3-nueva', amountCents: 500, createdAt: new Date('2026-07-15') }, // acumulada DESPUÉS de crear la liquidación
    ];
    const { svc, paid, outbox } = buildForSettleCapture(pending);
    // El monto pagado = snapshot del total al crear la liquidación (6000+4200), NO incluye la nueva.
    await settleDebtsOnCapture(svc, {
      id: 'pay-settle',
      amountCents: 10200,
      debtSettlementDriverId: 'drv-1',
    });
    expect(paid.map((p) => p.id)).toEqual(['d1', 'd2']); // d3-nueva queda PENDING
    expect(outbox.filter((e) => e.eventType === 'driver.debt_cleared')).toHaveLength(1);
  });

  it('sin debtSettlementDriverId → no marca nada ni emite (guard defensivo)', async () => {
    const { svc, paid, outbox } = buildForSettleCapture([]);
    await settleDebtsOnCapture(svc, { id: 'pay-x', amountCents: 100, debtSettlementDriverId: null });
    expect(paid).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});

// ── 6 · settleDriverDebt: sin deuda 409 + idempotencia ─────────────────────────────────────────────
function buildForSettle(pending: Row[], existing: Row | null) {
  const repo = {
    findPendingDebtsByDriver: async () => pending,
    findPaymentByDedupKey: async () => existing,
  };
  const gateway = { supports: () => true };
  const svc = new PaymentsService(
    repo as never,
    gateway as never,
    {} as never,
    {} as never,
    config(10000) as never,
  );
  return svc;
}

describe('ADR-022 §P-A · settleDriverDebt (endpoint del conductor)', () => {
  it('sin deuda PENDING → InvalidStateError (409, nada que saldar)', async () => {
    const svc = buildForSettle([], null);
    await expect(
      svc.settleDriverDebt({ driverId: 'drv-1', method: 'YAPE' }),
    ).rejects.toThrow(/deuda/i);
  });

  it('CASH → InvalidStateError (la deuda se salda por medio digital)', async () => {
    const svc = buildForSettle([{ id: 'd1', amountCents: 400, tripId: 't1' }], null);
    await expect(
      svc.settleDriverDebt({ driverId: 'drv-1', method: 'CASH' }),
    ).rejects.toThrow(/DIGITAL/i);
  });

  it('idempotente: una liquidación PENDING en curso → devuelve la MISMA sin re-cobrar', async () => {
    const existing = { id: 'pay-settle', status: 'PENDING', amountCents: 400 };
    const svc = buildForSettle([{ id: 'd1', amountCents: 400, tripId: 't1' }], existing);
    const result = await svc.settleDriverDebt({ driverId: 'drv-1', method: 'YAPE' });
    expect(result).toBe(existing);
  });
});
