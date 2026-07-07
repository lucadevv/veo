import { describe, it, expect } from 'vitest';
import { BPS_PER_PERCENT, bpsToPercentLabel, percentToBps } from './commission';

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
