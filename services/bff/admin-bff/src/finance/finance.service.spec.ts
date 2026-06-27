/**
 * FinanceService (admin-bff) · ADR-015 D6 / hueco #4 — el panel FINANCE ve el DESGLOSE, no un monto opaco.
 * Lo crítico a fijar: `listPayouts` mapea a `payoutView` SIN descartar el desglose que payment-service ya
 * sirve (gross/commission/neto/processedAt/heldReason). Antes `toPayoutView` recortaba a id/driverId/neto/
 * status/period → el operador veía el neto sin poder auditar bruto ni comisión (paridad rota con la app del
 * conductor). Este test es el guardrail de que el desglose viaja de punta a punta.
 */
import { describe, it, expect, vi } from 'vitest';
import { payoutView } from '@veo/api-client';
import { FinanceService } from './finance.service';

const operator = { userId: 'op-1', type: 'admin', roles: ['FINANCE'] } as never;

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

function makeService(rows: PayoutRow[]) {
  const rest = {
    get: vi.fn().mockResolvedValue({ items: rows, nextCursor: null }),
    post: vi.fn(),
  };
  // REST_BOOKING (F2.5 · costo/km): cliente separado hacia booking-service. Stub vacío salvo en sus tests.
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const svc = new FinanceService(rest as never, bookingRest as never, audit as never);
  return { svc, rest, bookingRest, audit };
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
