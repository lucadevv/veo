/**
 * A1 (ADR-022 · Model B) · addTip — TODA propina iniciada en el app se COBRA DIGITAL; el conductor la cobra SOLO
 * cuando el cobro CAPTURA (entra al payout por su tipCents). Crea un tip-Payment DEDICADO (kind=TIP, gross 0,
 * comisión 0, 100% al conductor). Antes no se cobraba nada al pasajero y el conductor la recibía igual (la
 * plataforma la subsidiaba). El MÉTODO de la propina = el de la tarifa si fue digital; si el viaje se pagó en
 * EFECTIVO cae a YAPE por defecto (el gateway no cobra CASH). Idempotente por Payment.dedupKey (`tip-charge:`).
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';
import { TIP_CHARGE_DEDUP_PREFIX } from './payment.policy';

type Row = Record<string, unknown>;

function buildService(
  fare: Row | null,
  opts: { existingTipCharge?: Row | null; walletUid?: string | null; chargeResult?: Row } = {},
) {
  const created: Row[] = [];
  const updated: Row[] = [];
  // Mock del PaymentsRepository: el cobro de propina lee la tarifa viva, persiste el tip-Payment y (según el
  // desenlace del gateway) persiste el checkout o marca FAILED la propina. NO usa la tx de la tarifa (markTipFailed
  // es un update PLANO).
  const repo = {
    findPaymentByDedupKey: vi.fn(async () => opts.existingTipCharge ?? null), // idempotencia del cobro de propina
    findLiveFareByTrip: vi.fn(async () => fare),
    findPaymentById: vi.fn(async () => updated[0] ?? created[0] ?? fare), // getPayment(id) / dup lookups
    createPayment: vi.fn(async (data: Row) => {
      created.push(data);
      return { ...data };
    }),
    persistAggregatorCheckout: vi.fn(async (_id: string, data: Row) => {
      const u = { ...(created[0] ?? fare), ...data };
      updated.push(u);
      return u;
    }),
    markTipFailed: vi.fn(async (_id: string, data: Row) => {
      const u = { ...(created[0] ?? fare), ...data };
      updated.push(u);
      return u;
    }),
  };
  const gateway = {
    chargeFlow: 'aggregator' as const,
    supports: () => true,
    charge: vi.fn(
      async () =>
        opts.chargeResult ?? {
          status: 'PENDING_EXTERNAL' as const,
          externalRef: 'uid-tip-1',
          checkout: { qrCodeBase64: 'data:image/png;base64,AAAA' },
        },
    ),
  };
  const affiliations = { resolveActiveWalletUid: vi.fn(async () => opts.walletUid ?? null) };
  const config = { getOrThrow: () => 0 };
  const service = new PaymentsService(
    repo as never,
    gateway as never,
    affiliations as never,
    {} as never, // promotions (no se usa: la propina NO canjea promo/crédito)
    config as never,
  );
  return { service, created, updated, gateway };
}

const yapeFare: Row = {
  id: 'fare-1',
  tripId: 'trip-1',
  method: 'YAPE',
  driverId: 'drv-1',
  passengerId: 'pax-1',
  payerRef: '999888777',
  kind: 'FARE',
  status: 'CAPTURED',
  tipCents: 0,
};
const plinFare: Row = { ...yapeFare, id: 'fare-plin', method: 'PLIN' };
const cashFare: Row = { ...yapeFare, id: 'fare-cash', method: 'CASH', payerRef: null };

describe('A1 · addTip — la propina SIEMPRE se cobra digital (Model B)', () => {
  it('viaje DIGITAL → tip-Payment kind=TIP (gross 0, comisión 0, 100% propina) con el MISMO método, cobrado', async () => {
    const { service, created, gateway } = buildService(yapeFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-1' });

    expect(created).toHaveLength(1);
    const tip = created[0]!;
    expect(tip.kind).toBe('TIP');
    expect(tip.grossCents).toBe(0);
    expect(tip.commissionCents).toBe(0);
    expect(tip.feeCents).toBe(0);
    expect(tip.tipCents).toBe(500);
    expect(tip.amountCents).toBe(500);
    expect(tip.method).toBe('YAPE'); // el MISMO método con que pagó la tarifa
    expect(tip.driverId).toBe('drv-1');
    expect(tip.status).toBe('PENDING'); // entra al payout recién al CAPTURAR (webhook), no ahora
    expect(String(tip.dedupKey)).toBe(`${TIP_CHARGE_DEDUP_PREFIX}nonce-1`);
    expect(gateway.charge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 500, method: 'YAPE' }),
    );
  });

  it('viaje en EFECTIVO → la propina se cobra DIGITAL con YAPE por defecto (no "en mano", el conductor la cobra)', async () => {
    const { service, created, gateway } = buildService(cashFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 300, dedupKey: 'nonce-cash' });

    expect(created).toHaveLength(1);
    const tip = created[0]!;
    expect(tip.kind).toBe('TIP');
    expect(tip.method).toBe('YAPE'); // NO hereda CASH (el gateway no cobra efectivo) → default digital
    expect(tip.tipCents).toBe(300);
    expect(tip.amountCents).toBe(300);
    // se DESPACHÓ un cobro real de la propina por el riel digital (no se perdió por "en mano")
    expect(gateway.charge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 300, method: 'YAPE' }),
    );
  });

  it('viaje PLIN → la propina cobra con PLIN (hereda el método digital de la tarifa)', async () => {
    const { service, created } = buildService(plinFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-plin' });
    expect(created[0]!.method).toBe('PLIN');
  });

  it('idempotente → si ya existe el tip-Payment de esa dedupKey, no re-cobra', async () => {
    const existing = { id: 'tip-existing', kind: 'TIP', status: 'PENDING', tipCents: 500 };
    const { service, created, gateway } = buildService(yapeFare, { existingTipCharge: existing });
    const out = await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-1' });

    expect(out).toEqual(existing);
    expect(created).toHaveLength(0);
    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('rechaza propina no-entera o <= 0', async () => {
    const { service } = buildService(yapeFare);
    await expect(
      service.addTip({ tripId: 'trip-1', tipCents: 0, dedupKey: 'x' }),
    ).rejects.toThrow();
    await expect(
      service.addTip({ tripId: 'trip-1', tipCents: 1.5, dedupKey: 'x' }),
    ).rejects.toThrow();
  });

  it('la propina que DECLINA → FAILED terminal (no DEBT), sin emitir payment.failed (no bloquea ni alerta)', async () => {
    const { service, updated } = buildService(yapeFare, {
      chargeResult: { status: 'DECLINED', reason: 'insufficient_funds', failureKind: 'declined' },
    });
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-decl' });
    // markDebt(kind=TIP) marca FAILED con un update PLANO (no la tx que emite payment.failed de la tarifa).
    expect(updated).toHaveLength(1);
    expect(updated[0]!.status).toBe('FAILED');
  });
});

/** Read-side: los lookups que asumían "un payment = una tarifa" NO deben contaminarse con el tip-Payment. */
describe('A1 · el tip-Payment NO contamina los lookups de la tarifa', () => {
  it('getDebtForPassenger consulta las dos clases FARE (deuda + pendientes) → una propina fallida NO entra al gate', async () => {
    // El filtro kind=FARE ahora vive DENTRO del repo (findPassengerDebtPayments / findPassengerPendingPayments,
    // ambos hardcodean kind=FARE): el service invoca las dos lecturas FARE-scoped + las penalidades y compone el
    // resumen. Verificamos que las dos clases de deuda de VIAJE se consultan y que, vacías, no hay gate.
    const findDebt = vi.fn(async (): Promise<Row[]> => []);
    const findPending = vi.fn(async (): Promise<Row[]> => []);
    const repo = {
      findPassengerDebtPayments: findDebt,
      findPassengerPendingPayments: findPending,
      findPassengerPendingPenalties: vi.fn(async () => []),
    };
    const svc = new PaymentsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 0 } as never,
    );
    const out = await svc.getDebtForPassenger('pax-1');
    expect(out.hasDebt).toBe(false);
    // Las dos lecturas FARE-scoped se invocan (la garantía kind=FARE la cristaliza el repo).
    expect(findDebt).toHaveBeenCalledTimes(1);
    expect(findPending).toHaveBeenCalledTimes(1);
  });

  it('propina que EXPIRA (webhook, checkout abandonado) → FAILED terminal SIN payment.failed (markDebt kind-aware)', async () => {
    const tip: Row = {
      id: 'tip-x',
      tripId: 'trip-1',
      kind: 'TIP',
      status: 'PENDING',
      method: 'YAPE',
      amountCents: 500,
      tipCents: 500,
      driverId: 'drv-1',
    };
    const updates: Row[] = [];
    const runInTransaction = vi.fn(); // la tx SOLO se usa en el camino de la TARIFA (que emite payment.failed)
    const repo = {
      findPaymentById: vi.fn(async () => tip),
      markTipFailed: vi.fn(async (_id: string, data: Row) => {
        updates.push(data);
        return { ...tip, ...data };
      }),
      runInTransaction,
    };
    const svc = new PaymentsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 0 } as never,
    );
    const out = await svc.applyWebhookResult({
      paymentId: 'tip-x',
      externalUid: 'uid-x',
      status: 'EXPIRED',
    });
    expect(out.status).toBe('FAILED');
    expect(updates[0]!.status).toBe('FAILED');
    expect(runInTransaction).not.toHaveBeenCalled(); // el tip NO pasa por la tx que emite payment.failed → no alerta
  });

  it('FARE que EXPIRA (checkout de un viaje COMPLETADO) → DEBT, NO FAILED terminal: gatea + reintentable (no viaje gratis)', async () => {
    const fare: Row = {
      id: 'fare-x',
      tripId: 'trip-1',
      kind: 'FARE',
      status: 'PENDING',
      method: 'YAPE',
      amountCents: 5000,
      driverId: 'drv-1',
    };
    const updates: Row[] = [];
    const outbox: { eventType: string }[] = [];
    // markDebt (no-TIP) corre en runInTransaction: markPaymentDebtInTx a DEBT + enqueueOutbox(payment.failed).
    const repo = {
      findPaymentById: vi.fn(async () => fare),
      runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
      markPaymentDebtInTx: vi.fn(async (_tx: unknown, _id: string, data: Row) => {
        updates.push(data);
        return { ...fare, ...data };
      }),
      enqueueOutbox: vi.fn(async (_tx: unknown, envelope: { eventType: string }) => {
        outbox.push({ eventType: envelope.eventType });
      }),
    };
    const svc = new PaymentsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 0 } as never,
    );
    const out = await svc.applyWebhookResult({
      paymentId: 'fare-x',
      externalUid: 'uid-x',
      status: 'EXPIRED',
    });
    expect(out.status).toBe('DEBT'); // NO 'FAILED' terminal → el viaje NO queda gratis
    expect(updates[0]!.status).toBe('DEBT'); // el pago queda en DEBT: gatea al pasajero + reintentable
    expect(outbox.map((o) => o.eventType)).toContain('payment.failed'); // willRetry=false → bloquea nuevos viajes
  });

  it('earningsForDriver: la propina suma en tipCents pero NO cuenta como viaje (tripCount solo FARE)', async () => {
    const rows = [
      { grossCents: 2000, commissionCents: 400, tipCents: 0, kind: 'FARE' },
      { grossCents: 0, commissionCents: 0, tipCents: 300, kind: 'TIP' }, // propina digital capturada
    ];
    const repo = { findDriverCapturedPayments: vi.fn(async () => rows) };
    const svc = new PaymentsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 0 } as never,
    );
    const out = await svc.earningsForDriver('drv-1', new Date(0), new Date(1e13));
    expect(out.tipCents).toBe(300); // la propina SÍ cuenta como ganancia
    expect(out.netCents).toBe(2000 - 400 + 300);
    expect(out.tripCount).toBe(1); // pero NO como un viaje extra
  });
});

describe('applyWebhookResult · idempotente sobre pagos YA LIQUIDADOS (no loop de re-entrega no-2xx)', () => {
  const svcFor = (status: string) => {
    const payment: Row = {
      id: 'p-x',
      tripId: 'trip-1',
      kind: 'FARE',
      status,
      method: 'YAPE',
      amountCents: 5000,
    };
    // Spies de escritura: un no-op idempotente NO debe tocar ninguno (ni captura/markDebt en tx, ni update plano).
    const runInTransaction = vi.fn();
    const markTipFailed = vi.fn();
    const repo = {
      findPaymentById: vi.fn(async () => payment),
      runInTransaction,
      markTipFailed,
    };
    const svc = new PaymentsService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 0 } as never,
    );
    return { svc, runInTransaction, markTipFailed };
  };

  for (const settled of ['REFUNDED', 'PARTIALLY_REFUNDED'] as const) {
    for (const hook of ['CONFIRMED', 'DECLINED', 'EXPIRED'] as const) {
      it(`${hook} sobre un pago ${settled} → no-op idempotente (NO InvalidStateError, sin escrituras)`, async () => {
        const { svc, runInTransaction, markTipFailed } = svcFor(settled);
        const out = await svc.applyWebhookResult({
          paymentId: 'p-x',
          externalUid: 'uid',
          status: hook,
        });
        // Antes PARTIALLY_REFUNDED (y REFUNDED en CONFIRMED) caía a captureSuccess/markDebt → assertTransition
        // lanzaba InvalidStateError (loop del proveedor). Ahora es un no-op limpio, sin tocar la DB.
        expect(out).toEqual({ applied: false, status: settled });
        expect(runInTransaction).not.toHaveBeenCalled();
        expect(markTipFailed).not.toHaveBeenCalled();
      });
    }
  }
});
