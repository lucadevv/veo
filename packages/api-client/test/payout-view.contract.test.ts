import { describe, expect, it } from 'vitest';
import { payoutView } from '../src/types.js';

/**
 * Test de contrato (ADR-015 D6 / hueco #4): el `payoutView` debe parsear EXACTAMENTE lo que el admin-bff
 * sirve para el panel FINANCE — con el DESGLOSE completo: gross/commission/neto + processedAt + heldReason.
 * Antes el contrato solo tenía id/driverId/amountCents/status/period → el operador veía un monto OPACO.
 * La ampliación es ADDITIVE: `amountCents` queda = NETO (paridad con lo que el conductor ve en su app).
 */
describe('payoutView contract · ADR-015 D6', () => {
  it('parsea un payout PROCESADO con el desglose completo', () => {
    const fromBff = {
      id: 'pay-1',
      driverId: 'drv-1',
      grossCents: 10000,
      commissionCents: 2000,
      amountCents: 8000, // NETO = gross − commission
      status: 'PROCESSED',
      period: '2026-06-16T00:00:00.000Z..2026-06-22T23:59:59.999Z',
      processedAt: '2026-06-23T12:00:00.000Z',
      heldReason: null,
    };
    expect(payoutView.parse(fromBff)).toEqual(fromBff);
  });

  it('parsea un payout HELD: heldReason poblado, processedAt null', () => {
    const held = payoutView.parse({
      id: 'pay-2',
      driverId: 'drv-2',
      grossCents: 5000,
      commissionCents: 1000,
      amountCents: 4000,
      status: 'HELD',
      period: '2026-06-16..2026-06-22',
      processedAt: null,
      heldReason: 'driver_in_review',
    });
    expect(held.heldReason).toBe('driver_in_review');
    expect(held.processedAt).toBeNull();
  });

  it('exige el desglose: rechaza un payout sin grossCents/commissionCents (contrato roto)', () => {
    expect(() =>
      payoutView.parse({
        id: 'pay-3',
        driverId: 'drv-3',
        amountCents: 8000,
        status: 'PROCESSED',
        period: '2026-06-16..2026-06-22',
        processedAt: null,
        heldReason: null,
      }),
    ).toThrow();
  });

  it('el dinero es Int céntimos: rechaza un gross decimal', () => {
    expect(() =>
      payoutView.parse({
        id: 'pay-4',
        driverId: 'drv-4',
        grossCents: 100.5,
        commissionCents: 2000,
        amountCents: 8000,
        status: 'PROCESSED',
        period: '2026-06-16..2026-06-22',
        processedAt: null,
        heldReason: null,
      }),
    ).toThrow();
  });
});
