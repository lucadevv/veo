import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('combina clases y omite valores falsy', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
  });

  it('resuelve conflictos de Tailwind (twMerge gana el último)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-ink', 'text-danger')).toBe('text-danger');
  });

  it('soporta clases condicionales', () => {
    const active = true;
    expect(cn('base', active && 'on')).toBe('base on');
  });
});
