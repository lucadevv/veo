import { formatPEN, formatShortDate } from '../format';

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

/**
 * Regresión del OFF-BY-ONE de fecha (Lima = UTC-5): `new Date('1998-12-07')` se interpreta a medianoche
 * UTC y, al localizar, RETROCEDE al día 6. El consumidor (DateField, RegistrationDocumentSheet) muestra
 * el `birthDate`/vencimiento con `formatShortDate`, así que el día visible debe ser EXACTAMENTE el del
 * ISO, sin importar el huso. El fix arma el `Date` con componentes LOCALES (mediodía) para un date-only.
 */
describe('formatShortDate (fecha sin desfase de huso)', () => {
  it('un date-only `1998-12-07` se MUESTRA como día 7 (no 6) — bug off-by-one corregido', () => {
    const text = formatShortDate('1998-12-07');
    // Día y mes exactos, en cualquier TZ del runner (el bug aparecía solo en husos negativos como Lima).
    expect(text).toMatch(/\b07\b/);
    expect(text.toLowerCase()).toContain('dic');
    expect(text).toContain('1998');
    expect(text).not.toMatch(/\b06\b/);
  });

  it('reproduce el huso de Lima (UTC-5) y aún muestra el día 7', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Lima';
    try {
      // En husos negativos el bug retrocedía a "06 dic 1998"; con el fix sigue siendo el 7.
      expect(formatShortDate('1998-12-07')).toMatch(/\b07\b/);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('fecha inválida → cadena vacía (degradación honesta)', () => {
    expect(formatShortDate('no-es-fecha')).toBe('');
    expect(formatShortDate('')).toBe('');
  });
});
