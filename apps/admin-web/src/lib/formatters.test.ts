import { describe, expect, it } from 'vitest';
import { dateTime, duration, money } from './formatters';

describe('formatters', () => {
  it('money formatea céntimos PEN', () => {
    expect(money(1500)).toBe('S/ 15.00');
    expect(money(0)).toBe('S/ 0.00');
  });

  it('duration convierte segundos en texto legible', () => {
    expect(duration(0)).toBe('0 min');
    expect(duration(90)).toBe('1 min');
    expect(duration(3660)).toBe('1 h 01 min');
    expect(duration(null)).toBe('—');
  });

  it('dateTime maneja entradas inválidas', () => {
    expect(dateTime(null)).toBe('—');
    expect(dateTime('no-es-fecha')).toBe('—');
  });
});
