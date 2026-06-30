import { describe, it, expect } from 'vitest';
import type { CommissionView } from '@/lib/api/schemas';
import {
  BPS_PER_PERCENT,
  bpsToPercentLabel,
  commissionReplace,
  percentToBps,
} from './commission';

const view = (
  onDemandRateBps: number,
  carpoolingFeeBps: number,
  version = 1,
): CommissionView => ({
  onDemandRateBps,
  carpoolingFeeBps,
  version,
  updatedAt: '2026-06-30T00:00:00.000Z',
});

/** %↔bps: la tasa SIEMPRE viaja en bps Int (nunca float persistido). */
describe('percentToBps / bpsToPercentLabel · %↔bps Int', () => {
  it('20% → 2000 bps', () => {
    expect(percentToBps('20')).toBe(20 * BPS_PER_PERCENT);
  });

  it('redondea a Int (12.345% → 1235 bps, nunca float)', () => {
    expect(percentToBps('12.345')).toBe(1235);
    expect(Number.isInteger(percentToBps('12.345'))).toBe(true);
  });

  it('vacío = 0 (no NaN)', () => {
    expect(percentToBps('')).toBe(0);
    expect(percentToBps('   ')).toBe(0);
  });

  it('2000 bps → "20.00" para mostrar', () => {
    expect(bpsToPercentLabel(2000)).toBe('20.00');
  });
});

/**
 * EL invariante de dinero: cada panel edita UN carril y el save debe PRESERVAR la tasa del otro. El config tiene
 * AMBAS tasas con UNA sola versión (CAS) — perder la del carril que no se toca sería borrar dinero. Es el mismo
 * blindaje que `bidFloorDefaultReplace` da al adelgazamiento del panel de Precios (A2).
 */
describe('commissionReplace · cambia UN carril PRESERVANDO el otro', () => {
  it('on-demand: cambia onDemandRateBps y preserva carpoolingFeeBps INTACTO', () => {
    const body = commissionReplace(view(2000, 1500, 7), { onDemandRateBps: 2500 });
    expect(body).toEqual({
      onDemandRateBps: 2500,
      carpoolingFeeBps: 1500,
      expectedVersion: 7,
    });
  });

  it('carpooling: cambia carpoolingFeeBps y preserva onDemandRateBps INTACTO', () => {
    const body = commissionReplace(view(2000, 1500, 7), { carpoolingFeeBps: 1200 });
    expect(body).toEqual({
      onDemandRateBps: 2000,
      carpoolingFeeBps: 1200,
      expectedVersion: 7,
    });
  });

  it('NO pisa la tasa del otro carril aunque el panel ya no la muestre (regresión de dinero)', () => {
    // el panel on-demand ni conoce el carpooling: igual debe remandarlo tal cual está persistido
    expect(commissionReplace(view(3300, 800), { onDemandRateBps: 0 }).carpoolingFeeBps).toBe(800);
    // y a la inversa
    expect(commissionReplace(view(3300, 800), { carpoolingFeeBps: 0 }).onDemandRateBps).toBe(3300);
  });

  it('remite expectedVersion = la versión cargada (CAS), no la reinventa', () => {
    expect(
      commissionReplace(view(2000, 1500, 42), { onDemandRateBps: 1000 }).expectedVersion,
    ).toBe(42);
  });
});
