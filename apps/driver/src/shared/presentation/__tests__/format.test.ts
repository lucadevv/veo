import {formatPEN} from '../format';

/**
 * Regresión del dashboard: `formatPEN` se usa para los KPIs de ganancias. Si un campo opcional llega
 * ausente o el dato viene fuera de contrato, el helper debe degradar a "S/ 0.00", nunca a "S/ NaN".
 */
describe('formatPEN (defensa de montos)', () => {
  it('formatea céntimos válidos a soles', () => {
    expect(formatPEN(1500)).toBe('S/ 15.00');
    expect(formatPEN(0)).toBe('S/ 0.00');
  });

  it('degrada undefined/null/NaN a S/ 0.00 (nunca "S/ NaN")', () => {
    expect(formatPEN(undefined)).toBe('S/ 0.00');
    expect(formatPEN(null)).toBe('S/ 0.00');
    expect(formatPEN(Number.NaN)).toBe('S/ 0.00');
    expect(formatPEN(Number.POSITIVE_INFINITY)).toBe('S/ 0.00');
  });
});
