import { describe, expect, it } from 'vitest';
import { parseSolesInput, formatSolesInput } from './money';

describe('parseSolesInput', () => {
  it('vacío/blanco vale 0 céntimos', () => {
    expect(parseSolesInput('')).toBe(0);
    expect(parseSolesInput('   ')).toBe(0);
  });

  it('redondea al céntimo (paridad con el Math.round(x*100) viejo)', () => {
    expect(parseSolesInput('15')).toBe(1500);
    expect(parseSolesInput('1.50')).toBe(150);
    expect(parseSolesInput('0.005')).toBe(1); // 0.5 céntimos → redondea a 1 (half-up)
    expect(parseSolesInput('0.004')).toBe(0);
  });

  it('tolera espacios alrededor del número', () => {
    expect(parseSolesInput('  1.5  ')).toBe(150);
  });
});

describe('formatSolesInput', () => {
  it('céntimos → string de input con 2 decimales, sin "S/" ni separadores', () => {
    expect(formatSolesInput(1500)).toBe('15.00');
    expect(formatSolesInput(150)).toBe('1.50');
    expect(formatSolesInput(0)).toBe('0.00');
    expect(formatSolesInput(123456)).toBe('1234.56'); // sin coma de miles
  });
});
