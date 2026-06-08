import { describe, it, expect } from 'vitest';
import { isPlausibleBirthDate } from './is-plausible-birth-date';

// "Hoy" fijo para tests deterministas.
const NOW = new Date('2026-05-31T12:00:00.000Z');

describe('isPlausibleBirthDate', () => {
  it('acepta una fecha pasada con edad plausible (36 años)', () => {
    expect(isPlausibleBirthDate('1990-05-21', NOW)).toBe(true);
  });

  it('acepta justo el límite de 18 años cumplidos hoy', () => {
    expect(isPlausibleBirthDate('2008-05-31', NOW)).toBe(true);
  });

  it('rechaza si aún no cumple 18 (cumple mañana)', () => {
    expect(isPlausibleBirthDate('2008-06-01', NOW)).toBe(false);
  });

  it('rechaza una fecha futura', () => {
    expect(isPlausibleBirthDate('2030-01-01', NOW)).toBe(false);
  });

  it('rechaza una edad implausible (>100 años)', () => {
    expect(isPlausibleBirthDate('1900-01-01', NOW)).toBe(false);
  });

  it('acepta el límite de 100 años cumplidos', () => {
    expect(isPlausibleBirthDate('1926-05-31', NOW)).toBe(true);
  });

  it('rechaza formato inválido o no-string', () => {
    expect(isPlausibleBirthDate('21-05-1990', NOW)).toBe(false);
    expect(isPlausibleBirthDate('1990/05/21', NOW)).toBe(false);
    expect(isPlausibleBirthDate(19900521, NOW)).toBe(false);
    expect(isPlausibleBirthDate(null, NOW)).toBe(false);
  });

  it('rechaza una fecha calendario imposible (2024-02-31)', () => {
    expect(isPlausibleBirthDate('2024-02-31', NOW)).toBe(false);
  });
});
