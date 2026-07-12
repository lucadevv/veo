/**
 * FinanceService (admin-bff) · ADR-015 D6 / hueco #4 — el panel FINANCE ve el DESGLOSE, no un monto opaco.
 * Lo crítico a fijar: `listPayouts` mapea a `payoutView` SIN descartar el desglose que payment-service ya
 * sirve (gross/commission/neto/processedAt/heldReason). Antes `toPayoutView` recortaba a id/driverId/neto/
 * status/period → el operador veía el neto sin poder auditar bruto ni comisión (paridad rota con la app del
 * conductor). Este test es el guardrail de que el desglose viaja de punta a punta.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  payoutView,
  payoutDetailView,
  payoutStatsView,
  refundablePaymentView,
  reconciliationRunView,
} from '@veo/api-client';
import { FinanceService } from './finance.service';

// FINANCE puro: NO ve identidad personal (canSeeIdentity=false) → driverName degrada a null y NO se llama a identity.
const operator = { userId: 'op-1', type: 'admin', roles: ['FINANCE'] } as never;
// ADMIN: SÍ ve identidad (canSeeIdentity=true) → driverName se resuelve vía GetDriversByIds.
const adminOperator = { userId: 'op-2', type: 'admin', roles: ['ADMIN'] } as never;

/** Deps de identidad para el enriquecimiento de nombres (gRPC identity + config del secret HMAC). */
function identityDeps(drivers: { id: string; name: string }[] = []) {
  const identityGrpc = { call: vi.fn().mockResolvedValue({ drivers }) };
  const config = { get: vi.fn().mockReturnValue('test-secret') };
  return { identityGrpc, config };
}

/** Fila REAL que payment-service sirve en GET /payouts/all (findMany SIN select → Payout completo). */
interface PayoutRow {
  id: string;
  driverId: string;
  grossCents: number;
  commissionCents: number;
  amountCents: number;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'HELD' | 'FAILED';
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  heldReason: string | null;
}

function processedRow(): PayoutRow {
  return {
    id: 'pay-1',
    driverId: 'drv-1',
    grossCents: 10000, // S/ 100.00 bruto
    commissionCents: 2000, // 20% retención
    amountCents: 8000, // neto al conductor
    status: 'PROCESSED',
    periodStart: '2026-06-16T00:00:00.000Z',
    periodEnd: '2026-06-22T23:59:59.999Z',
    processedAt: '2026-06-23T12:00:00.000Z',
    heldReason: null,
  };
}

function heldRow(): PayoutRow {
  return {
    id: 'pay-2',
    driverId: 'drv-2',
    grossCents: 5000,
    commissionCents: 1000,
    amountCents: 4000,
    status: 'HELD',
    periodStart: '2026-06-16T00:00:00.000Z',
    periodEnd: '2026-06-22T23:59:59.999Z',
    processedAt: null,
    heldReason: 'driver_in_review',
  };
}

function makeService(rows: PayoutRow[], drivers: { id: string; name: string }[] = []) {
  const rest = {
    get: vi.fn().mockResolvedValue({ items: rows, nextCursor: null }),
    post: vi.fn(),
  };
  // REST_BOOKING (F2.5 · costo/km): cliente separado hacia booking-service. Stub vacío salvo en sus tests.
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const { identityGrpc, config } = identityDeps(drivers);
  const svc = new FinanceService(
    rest as never,
    bookingRest as never,
    identityGrpc as never,
    'admin-rail' as never,
    audit as never,
    config as never,
  );
  return { svc, rest, bookingRest, audit, identityGrpc };
}

describe('FinanceService.listPayouts · ADR-015 D6 (desglose)', () => {
  it('expone gross/commission/neto/processedAt en el payoutView (no recorta el desglose)', async () => {
    const { svc, rest } = makeService([processedRow()]);
    const page = await svc.listPayouts(operator, { status: 'PROCESSED' });

    expect(rest.get).toHaveBeenCalledWith(
      '/payouts/all',
      expect.objectContaining({ query: expect.objectContaining({ status: 'PROCESSED' }) }),
    );

    const view = page.items[0];
    expect(view).toEqual({
      id: 'pay-1',
      driverId: 'drv-1',
      driverName: null, // operador FINANCE puro: identidad redactada (canSeeIdentity=false)
      grossCents: 10000,
      commissionCents: 2000,
      amountCents: 8000, // amountCents = NETO
      status: 'PROCESSED',
      period: '2026-06-16T00:00:00.000Z..2026-06-22T23:59:59.999Z',
      processedAt: '2026-06-23T12:00:00.000Z',
      heldReason: null,
    });
  });

  it('el resultado satisface el contrato Zod payoutView (parse no lanza)', async () => {
    const { svc } = makeService([processedRow(), heldRow()]);
    const page = await svc.listPayouts(operator, {});
    for (const view of page.items) {
      expect(() => payoutView.parse(view)).not.toThrow();
    }
  });

  it('conserva heldReason cuando el payout está HELD (motivo de retención auditable)', async () => {
    const { svc } = makeService([heldRow()]);
    const page = await svc.listPayouts(operator, { status: 'HELD' });
    const view = page.items[0];
    expect(view?.status).toBe('HELD');
    expect(view?.heldReason).toBe('driver_in_review');
    expect(view?.processedAt).toBeNull();
  });
});

/**
 * getPaymentByTrip · hueco #2 — el operador inspecciona el cobro reembolsable ANTES de reembolsar. Lo crítico:
 *  (1) llama la ruta interna correcta con la identidad; (2) el mapper RECORTA la PII de riel (externalRef/
 *  payerRef/externalUid) — NUNCA viaja al admin-web; (3) refundableCents = amount − refunded (clamp 0);
 *  (4) el acceso a la PII del pago queda AUDITADO (fail-closed).
 */
interface PaymentRowFull {
  id: string;
  tripId: string;
  driverId: string | null;
  passengerId: string | null;
  method: 'YAPE' | 'PLIN' | 'CASH' | 'CARD' | 'PAGOEFECTIVO';
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'DEBT';
  currency: string;
  grossCents: number;
  amountCents: number;
  refundedCents: number;
  discountCents: number;
  creditCents: number;
  tipCents: number;
  capturedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  // PII de RIEL que payment-service incluye en la fila cruda pero NO debe salir al admin-web:
  externalRef: string | null;
  payerRef: string | null;
  externalUid: string | null;
}

function paymentRow(over: Partial<PaymentRowFull> = {}): PaymentRowFull {
  return {
    id: 'pay-fare-1',
    tripId: 'trip-1',
    driverId: 'drv-1',
    passengerId: 'psg-1',
    method: 'YAPE',
    status: 'PARTIALLY_REFUNDED',
    currency: 'PEN',
    grossCents: 10000,
    amountCents: 9000,
    refundedCents: 2000,
    discountCents: 500,
    creditCents: 300,
    tipCents: 400,
    capturedAt: '2026-06-20T12:00:00.000Z',
    refundedAt: '2026-06-21T09:00:00.000Z',
    createdAt: '2026-06-20T11:59:00.000Z',
    externalRef: 'pp-ext-abc',
    payerRef: '+51999888777',
    externalUid: 'pp-uid-xyz',
    ...over,
  };
}

function makePaymentService(row: PaymentRowFull) {
  const rest = { get: vi.fn().mockResolvedValue(row), post: vi.fn() };
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const { identityGrpc, config } = identityDeps();
  const svc = new FinanceService(
    rest as never,
    bookingRest as never,
    identityGrpc as never,
    'admin-rail' as never,
    audit as never,
    config as never,
  );
  return { svc, rest, audit };
}

describe('FinanceService.getPaymentByTrip · hueco #2 (inspección previa al reembolso)', () => {
  it('llama la ruta interna /payments/by-trip/:tripId con la identidad del operador', async () => {
    const { svc, rest } = makePaymentService(paymentRow());
    await svc.getPaymentByTrip(operator, 'trip-1');
    expect(rest.get).toHaveBeenCalledWith(
      '/payments/by-trip/trip-1',
      expect.objectContaining({ identity: operator }),
    );
  });

  it('RECORTA la PII de riel: externalRef/payerRef/externalUid NUNCA salen en la view', async () => {
    const { svc } = makePaymentService(paymentRow());
    const view = await svc.getPaymentByTrip(operator, 'trip-1');
    expect(view).not.toHaveProperty('externalRef');
    expect(view).not.toHaveProperty('payerRef');
    expect(view).not.toHaveProperty('externalUid');
    // sí expone lo que la pantalla de reembolso necesita (ids de personas + montos, gateados + auditados):
    expect(view.paymentId).toBe('pay-fare-1');
    expect(view.driverId).toBe('drv-1');
    expect(view.passengerId).toBe('psg-1');
    expect(view.method).toBe('YAPE');
  });

  it('refundableCents = amount − ya reembolsado (el saldo que aún se puede devolver)', async () => {
    const { svc } = makePaymentService(paymentRow({ amountCents: 9000, refundedCents: 2000 }));
    const view = await svc.getPaymentByTrip(operator, 'trip-1');
    expect(view.refundableCents).toBe(7000);
  });

  it('refundableCents nunca es negativo (clamp a 0 si un dato viejo tuviera refunded > amount)', async () => {
    const { svc } = makePaymentService(paymentRow({ amountCents: 1000, refundedCents: 1500 }));
    const view = await svc.getPaymentByTrip(operator, 'trip-1');
    expect(view.refundableCents).toBe(0);
  });

  it('AUDITA el acceso a la PII del pago (payment.view_by_trip, resourceId = paymentId)', async () => {
    const { svc, audit } = makePaymentService(paymentRow());
    await svc.getPaymentByTrip(operator, 'trip-1');
    expect(audit.record).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        action: 'payment.view_by_trip',
        resourceType: 'payment',
        resourceId: 'pay-fare-1',
        payload: expect.objectContaining({ tripId: 'trip-1' }),
      }),
    );
  });

  it('el resultado satisface el contrato Zod refundablePaymentView (parse no lanza)', async () => {
    const { svc } = makePaymentService(paymentRow());
    const view = await svc.getPaymentByTrip(operator, 'trip-1');
    expect(() => refundablePaymentView.parse(view)).not.toThrow();
  });
});

/**
 * getPayoutDetail · hueco #1 — el panel FINANCE ve el breakdown de auditoría (deuda CASH + credit-back neteados
 * por FK). Lo crítico: (1) ruta interna correcta; (2) el mapper reusa toPayoutView + suma el breakdown;
 * (3) NO audita (a diferencia de getPaymentByTrip) — son montos del propio conductor, no PII de un tercero.
 */
interface PayoutDetailRowFull {
  id: string;
  driverId: string;
  grossCents: number;
  commissionCents: number;
  amountCents: number;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'HELD' | 'FAILED';
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  heldReason: string | null;
  debtAppliedCents: number;
  dedupKey: string | null;
  externalRef: string | null;
  createdAt: string;
  creditBackCents: number;
  debtSettledCents: number;
  bonusCents: number;
}

function payoutDetailRow(over: Partial<PayoutDetailRowFull> = {}): PayoutDetailRowFull {
  return {
    id: 'pay-detail-1',
    driverId: 'drv-1',
    grossCents: 10000,
    commissionCents: 2000,
    amountCents: 8300, // gross − commission − debtApplied(neto −300 = crédito a favor)
    status: 'PROCESSED',
    periodStart: '2026-06-16T00:00:00.000Z',
    periodEnd: '2026-06-22T23:59:59.999Z',
    processedAt: '2026-06-23T12:00:00.000Z',
    heldReason: null,
    debtAppliedCents: -300, // NETO firmado: 200 deuda − 500 crédito = −300 (a favor del conductor)
    dedupKey: 'payout-disburse:pay-detail-1',
    externalRef: 'rail-ref-xyz',
    createdAt: '2026-06-23T11:00:00.000Z',
    creditBackCents: 500,
    debtSettledCents: 200,
    bonusCents: 0, // payout sin bono de incentivo (componente NETO directo; no altera amountCents=8300)
    ...over,
  };
}

function makePayoutDetailService(
  row: PayoutDetailRowFull,
  drivers: { id: string; name: string }[] = [],
) {
  const rest = { get: vi.fn().mockResolvedValue(row), post: vi.fn() };
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const { identityGrpc, config } = identityDeps(drivers);
  const svc = new FinanceService(
    rest as never,
    bookingRest as never,
    identityGrpc as never,
    'admin-rail' as never,
    audit as never,
    config as never,
  );
  return { svc, rest, audit, identityGrpc };
}

describe('FinanceService.getPayoutDetail · hueco #1 (breakdown de auditoría)', () => {
  it('llama la ruta interna /payouts/:id con la identidad del operador', async () => {
    const { svc, rest } = makePayoutDetailService(payoutDetailRow());
    await svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(rest.get).toHaveBeenCalledWith('/payouts/pay-detail-1', { identity: operator });
  });

  it('expone el breakdown: debtSettled + creditBack + debtApplied(neto) + traza del desembolso', async () => {
    const { svc } = makePayoutDetailService(payoutDetailRow());
    const view = await svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(view.debtSettledCents).toBe(200);
    expect(view.creditBackCents).toBe(500);
    expect(view.debtAppliedCents).toBe(-300);
    expect(view.dedupKey).toBe('payout-disburse:pay-detail-1');
    expect(view.externalRef).toBe('rail-ref-xyz');
    // invariante del netting: debtApplied (neto firmado) = debtSettled − creditBack
    expect(view.debtAppliedCents).toBe(view.debtSettledCents - view.creditBackCents);
  });

  it('reusa el mapeo base (gross/commission/neto/period/status) — paridad con payoutView', async () => {
    const { svc } = makePayoutDetailService(payoutDetailRow());
    const view = await svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(view.grossCents).toBe(10000);
    expect(view.commissionCents).toBe(2000);
    expect(view.amountCents).toBe(8300);
    expect(view.period).toBe('2026-06-16T00:00:00.000Z..2026-06-22T23:59:59.999Z');
  });

  it('NO audita (montos del propio conductor, no PII de tercero — a diferencia de getPaymentByTrip)', async () => {
    const { svc, audit } = makePayoutDetailService(payoutDetailRow());
    await svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el resultado satisface el contrato Zod payoutDetailView (parse no lanza)', async () => {
    const { svc } = makePayoutDetailService(payoutDetailRow());
    const view = await svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(() => payoutDetailView.parse(view)).not.toThrow();
  });
});

/**
 * getReconciliation · hueco #3 — el panel FINANCE ve el historial de conciliación. Lo crítico: (1) ruta interna
 * /reconciliation con paginación; (2) el mapper APLANA el `details` Json a la view tipada; (3) corridas viejas
 * SIN details → period null + montos 0 (degradación honesta); (4) NO audita (data agregada, no PII de persona).
 */
interface ReconRowFull {
  id: string;
  ranAt: string;
  discrepancyPct: number;
  alerted: boolean;
  details: {
    periodStart?: string;
    periodEnd?: string;
    dbTotalCents?: number;
    statementTotalCents?: number;
    dbCount?: number;
    statementCount?: number;
  } | null;
  createdAt: string;
}

function reconRow(over: Partial<ReconRowFull> = {}): ReconRowFull {
  return {
    id: 'recon-1',
    ranAt: '2026-06-11T04:00:00.000Z',
    discrepancyPct: 0.002,
    alerted: false,
    details: {
      periodStart: '2026-06-10T00:00:00.000Z',
      periodEnd: '2026-06-11T00:00:00.000Z',
      dbTotalCents: 100_000,
      statementTotalCents: 100_200,
      dbCount: 40,
      statementCount: 40,
    },
    createdAt: '2026-06-11T04:00:00.000Z',
    ...over,
  };
}

function makeReconService(rows: ReconRowFull[]) {
  const rest = { get: vi.fn().mockResolvedValue({ items: rows, nextCursor: null }), post: vi.fn() };
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const { identityGrpc, config } = identityDeps();
  const svc = new FinanceService(
    rest as never,
    bookingRest as never,
    identityGrpc as never,
    'admin-rail' as never,
    audit as never,
    config as never,
  );
  return { svc, rest, audit };
}

describe('FinanceService.getReconciliation · hueco #3 (historial de conciliación)', () => {
  it('llama la ruta interna /reconciliation con la identidad + paginación', async () => {
    const { svc, rest } = makeReconService([reconRow()]);
    await svc.getReconciliation(operator, { cursor: 'c1', limit: 20 });
    expect(rest.get).toHaveBeenCalledWith(
      '/reconciliation',
      expect.objectContaining({
        identity: operator,
        query: expect.objectContaining({ cursor: 'c1', limit: 20 }),
      }),
    );
  });

  it('APLANA el details Json a la view tipada (montos DB vs extracto + conteos + discrepancia)', async () => {
    const { svc } = makeReconService([reconRow()]);
    const page = await svc.getReconciliation(operator, {});
    const view = page.items[0]!;
    expect(view.periodStart).toBe('2026-06-10T00:00:00.000Z');
    expect(view.dbTotalCents).toBe(100_000);
    expect(view.statementTotalCents).toBe(100_200);
    expect(view.dbCount).toBe(40);
    expect(view.discrepancyPct).toBe(0.002);
    expect(view.alerted).toBe(false);
  });

  it('corrida vieja SIN details → period null + montos/conteos en 0 (degradación honesta)', async () => {
    const { svc } = makeReconService([reconRow({ details: null })]);
    const page = await svc.getReconciliation(operator, {});
    const view = page.items[0]!;
    expect(view.periodStart).toBeNull();
    expect(view.periodEnd).toBeNull();
    expect(view.dbTotalCents).toBe(0);
    expect(view.statementCount).toBe(0);
  });

  it('NO audita (data agregada del sistema, no PII de una persona)', async () => {
    const { svc, audit } = makeReconService([reconRow()]);
    await svc.getReconciliation(operator, {});
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el resultado satisface el contrato Zod reconciliationRunView (parse no lanza)', async () => {
    const { svc } = makeReconService([
      reconRow(),
      reconRow({ id: 'recon-2', alerted: true, discrepancyPct: 0.05 }),
    ]);
    const page = await svc.getReconciliation(operator, {});
    for (const view of page.items) {
      expect(() => reconciliationRunView.parse(view)).not.toThrow();
    }
  });
});

/**
 * getPayoutStats · Seam 1 — KPIs de la pantalla de Liquidaciones (total liquidado + conteos por estado).
 * Passthrough tipado: (1) ruta interna /payouts/stats con la identidad; (2) NO audita (agregado, no PII);
 * (3) el resultado satisface el contrato Zod payoutStatsView.
 */
interface PayoutStatsFull {
  totalCents: number;
  paidCents: number;
  heldCents: number;
  failedCents: number;
  pendingCount: number;
  processingCount: number;
  processedCount: number;
  heldCount: number;
  failedCount: number;
}

function statsFixture(over: Partial<PayoutStatsFull> = {}): PayoutStatsFull {
  return {
    totalCents: 123_400,
    // Desglose de volumen por bucket (subconjuntos de totalCents): PROCESSED + HELD + FAILED = 117_400,
    // el resto (6_000) corresponde a PENDING/PROCESSING que no tienen bucket de volumen propio.
    paidCents: 98_000,
    heldCents: 15_000,
    failedCents: 4_400,
    pendingCount: 3,
    processingCount: 1,
    processedCount: 12,
    heldCount: 2,
    failedCount: 1,
    ...over,
  };
}

function makeStatsService(stats: PayoutStatsFull) {
  const rest = { get: vi.fn().mockResolvedValue(stats), post: vi.fn() };
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const { identityGrpc, config } = identityDeps();
  const svc = new FinanceService(
    rest as never,
    bookingRest as never,
    identityGrpc as never,
    'admin-rail' as never,
    audit as never,
    config as never,
  );
  return { svc, rest, audit };
}

describe('FinanceService.getPayoutStats · Seam 1 (KPIs de Liquidaciones)', () => {
  it('llama la ruta interna /payouts/stats con la identidad del operador', async () => {
    const { svc, rest } = makeStatsService(statsFixture());
    await svc.getPayoutStats(operator);
    expect(rest.get).toHaveBeenCalledWith(
      '/payouts/stats',
      expect.objectContaining({ identity: operator }),
    );
  });

  it('NO audita (agregado del sistema, no PII de persona)', async () => {
    const { svc, audit } = makeStatsService(statsFixture());
    await svc.getPayoutStats(operator);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('el resultado satisface el contrato Zod payoutStatsView (parse no lanza)', async () => {
    const { svc } = makeStatsService(statsFixture());
    const stats = await svc.getPayoutStats(operator);
    expect(() => payoutStatsView.parse(stats)).not.toThrow();
    expect(stats.totalCents).toBe(123_400);
    expect(stats.processedCount).toBe(12);
  });
});

/**
 * Seam 2 — enriquecimiento del NOMBRE del conductor (identity, batch anti-N+1) con GATE PII (Ley 29733).
 * Lo crítico: (1) FINANCE puro NO ve el nombre (canSeeIdentity=false) → null y NI SIQUIERA se llama a identity;
 * (2) ADMIN sí lo ve → un solo GetDriversByIds resuelve todos los driverIds de la página; (3) un id que identity
 * no resuelve degrada a null honesto; (4) idéntico gate en el detalle (getPayoutDetail).
 */
describe('FinanceService.listPayouts · Seam 2 (driverName enrichment + gate PII)', () => {
  it('FINANCE puro: driverName null y NO se llama a identity (sin fuga de PII ni round-trip)', async () => {
    const { svc, identityGrpc } = makeService(
      [processedRow(), heldRow()],
      [{ id: 'drv-1', name: 'María Ravello' }],
    );
    const page = await svc.listPayouts(operator, {});
    expect(page.items.every((v) => v.driverName === null)).toBe(true);
    expect(identityGrpc.call).not.toHaveBeenCalled();
  });

  it('ADMIN: resuelve driverName con UN solo GetDriversByIds para toda la página (anti-N+1)', async () => {
    const { svc, identityGrpc } = makeService(
      [processedRow(), heldRow()],
      [
        { id: 'drv-1', name: 'María Ravello' },
        { id: 'drv-2', name: 'Juan Pérez' },
      ],
    );
    const page = await svc.listPayouts(adminOperator, {});
    expect(identityGrpc.call).toHaveBeenCalledTimes(1);
    expect(identityGrpc.call).toHaveBeenCalledWith(
      'GetDriversByIds',
      { ids: ['drv-1', 'drv-2'] },
      expect.anything(),
    );
    expect(page.items[0]?.driverName).toBe('María Ravello');
    expect(page.items[1]?.driverName).toBe('Juan Pérez');
  });

  it('ADMIN: un driverId que identity NO resuelve degrada a null honesto (no se inventa)', async () => {
    const { svc } = makeService(
      [processedRow(), heldRow()],
      [
        { id: 'drv-1', name: 'María Ravello' },
        // drv-2 ausente en el reply de identity → null honesto
      ],
    );
    const page = await svc.listPayouts(adminOperator, {});
    expect(page.items[0]?.driverName).toBe('María Ravello');
    expect(page.items[1]?.driverName).toBeNull();
  });

  it('el resultado con driverName satisface el contrato Zod payoutView', async () => {
    const { svc } = makeService([processedRow()], [{ id: 'drv-1', name: 'María Ravello' }]);
    const page = await svc.listPayouts(adminOperator, {});
    for (const view of page.items) {
      expect(() => payoutView.parse(view)).not.toThrow();
    }
  });
});

describe('FinanceService.getPayoutDetail · Seam 2 (driverName enrichment + gate PII)', () => {
  it('ADMIN: enriquece driverName; FINANCE puro lo deja null', async () => {
    const admin = makePayoutDetailService(payoutDetailRow(), [
      { id: 'drv-1', name: 'María Ravello' },
    ]);
    const adminView = await admin.svc.getPayoutDetail(adminOperator, 'pay-detail-1');
    expect(adminView.driverName).toBe('María Ravello');
    expect(admin.identityGrpc.call).toHaveBeenCalledTimes(1);

    const fin = makePayoutDetailService(payoutDetailRow(), [
      { id: 'drv-1', name: 'María Ravello' },
    ]);
    const finView = await fin.svc.getPayoutDetail(operator, 'pay-detail-1');
    expect(finView.driverName).toBeNull();
    expect(fin.identityGrpc.call).not.toHaveBeenCalled();
  });
});

describe('FinanceService.getActiveCarpools · monitoreo (proxy a booking-service)', () => {
  it('proxya al REST interno de booking (active-carpools) propagando la identidad y devuelve el view tal cual', async () => {
    const view = {
      stats: {
        activeCount: 12,
        enRouteCount: 3,
        seatsReserved: 25,
        seatsAvailable: 15,
        avgOccupancyPct: 63,
      },
      carpools: [
        {
          id: 'c1',
          origenLat: -12.1,
          origenLon: -77.0,
          destinoLat: -12.0,
          destinoLon: -77.1,
          fechaHoraSalida: '2026-08-01T12:00:00.000Z',
          asientosTotales: 4,
          asientosReservados: 3,
          estado: 'PARCIALMENTE_RESERVADO',
          driverName: 'José Ramírez',
        },
      ],
    };
    const { svc, bookingRest } = makeService([]);
    bookingRest.get.mockResolvedValue(view);

    const res = await svc.getActiveCarpools(operator);

    expect(bookingRest.get).toHaveBeenCalledWith(
      '/internal/booking/active-carpools',
      expect.objectContaining({ identity: operator }),
    );
    expect(res).toEqual(view);
  });
});
