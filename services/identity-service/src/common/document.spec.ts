/**
 * Unit del validador/enmascarado de documento del pasajero (Yape On File · ProntoPaga).
 * Criterio per-tipo (DN=8 díg · CE 9-12 díg · PP 6-12 alfanum) + enmascarado para auditoría.
 */
import { describe, it, expect } from 'vitest';
import { isValidDocument, maskDocument } from './document';

describe('isValidDocument · criterio per-tipo', () => {
  it('DN exige exactamente 8 dígitos', () => {
    expect(isValidDocument('DN', '12345678')).toBe(true);
    expect(isValidDocument('DN', '1234567')).toBe(false); // 7
    expect(isValidDocument('DN', '123456789')).toBe(false); // 9
    expect(isValidDocument('DN', '1234567a')).toBe(false); // no dígito
  });

  it('CE exige 9-12 dígitos', () => {
    expect(isValidDocument('CE', '123456789')).toBe(true); // 9
    expect(isValidDocument('CE', '123456789012')).toBe(true); // 12
    expect(isValidDocument('CE', '12345678')).toBe(false); // 8
    expect(isValidDocument('CE', '1234567890123')).toBe(false); // 13
    expect(isValidDocument('CE', 'AB12345678')).toBe(false); // no dígito
  });

  it('PP exige 6-12 alfanuméricos', () => {
    expect(isValidDocument('PP', 'AB1234')).toBe(true); // 6
    expect(isValidDocument('PP', 'ABCDEF123456')).toBe(true); // 12
    expect(isValidDocument('PP', 'AB123')).toBe(false); // 5
    expect(isValidDocument('PP', 'ABCDEF1234567')).toBe(false); // 13
    expect(isValidDocument('PP', 'AB-123')).toBe(false); // símbolo
  });

  it('rechaza tipo desconocido o inputs no-string', () => {
    expect(isValidDocument('RUC', '12345678')).toBe(false);
    expect(isValidDocument(undefined, '12345678')).toBe(false);
    expect(isValidDocument('DN', undefined)).toBe(false);
    expect(isValidDocument('DN', 12345678 as unknown)).toBe(false);
  });
});

describe('maskDocument · auditoría sin PII completa', () => {
  it('conserva solo los últimos 2 caracteres', () => {
    expect(maskDocument('12345678')).toBe('******78');
    expect(maskDocument('AB1234')).toBe('****34');
  });

  it('nunca expone el valor completo', () => {
    expect(maskDocument('12345678')).not.toContain('123456');
  });

  it('maneja entradas cortas y nulas', () => {
    expect(maskDocument('12')).toBe('**');
    expect(maskDocument('1')).toBe('*');
    expect(maskDocument(null)).toBe('∅');
    expect(maskDocument(undefined)).toBe('∅');
  });
});
