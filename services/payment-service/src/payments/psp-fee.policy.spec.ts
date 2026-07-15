/**
 * P-B (ADR-022) · Fee del PSP (ProntoPaga): por método (CASH exento) + el neto real al banco = bruto − fee.
 * Enteros de céntimos (round), degradación honesta a 0 sin tarifa.
 */
import { describe, it, expect } from 'vitest';
import { resolvePspFeeBps, computePspSettlement } from './payment.policy';

describe('P-B · fee del PSP (policy)', () => {
  it('resolvePspFeeBps: por método; CASH → 0 (el efectivo no pasa por el PSP)', () => {
    const rates = { yapeFeeBps: 200, plinFeeBps: 150, cardFeeBps: 350, pagoefectivoFeeBps: 400 };
    expect(resolvePspFeeBps('YAPE', rates)).toBe(200);
    expect(resolvePspFeeBps('PLIN', rates)).toBe(150);
    expect(resolvePspFeeBps('CARD', rates)).toBe(350);
    expect(resolvePspFeeBps('PAGOEFECTIVO', rates)).toBe(400);
    expect(resolvePspFeeBps('CASH', rates)).toBe(0);
  });

  it('computePspSettlement: fee = round(amount × bps/10000), net = amount − fee', () => {
    expect(computePspSettlement(10000, 350)).toEqual({ pspFeeCents: 350, netSettledCents: 9650 }); // 3.5%
    expect(computePspSettlement(2300, 200)).toEqual({ pspFeeCents: 46, netSettledCents: 2254 }); // 2% de 2300
  });

  it('fee 0 (sin tarifa configurada del convenio) → net = amount (degradación honesta)', () => {
    expect(computePspSettlement(5000, 0)).toEqual({ pspFeeCents: 0, netSettledCents: 5000 });
  });
});
