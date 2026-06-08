import { describe, it, expect } from 'vitest';
import { maskPhone, maskDocument } from './masking';

describe('maskPhone', () => {
  it('deja visibles los últimos 4 dígitos', () => {
    expect(maskPhone('999881234')).toBe('*****1234');
  });
  it('ignora caracteres no numéricos', () => {
    expect(maskPhone('+51 999-88-1234')).toBe('*******1234');
  });
  it('enmascara todo si tiene 4 o menos dígitos', () => {
    expect(maskPhone('123')).toBe('***');
  });
});

describe('maskDocument', () => {
  it('deja visibles los últimos 2 caracteres', () => {
    expect(maskDocument('12345678')).toBe('******78');
  });
  it('enmascara todo si tiene 2 o menos', () => {
    expect(maskDocument('12')).toBe('**');
  });
});
