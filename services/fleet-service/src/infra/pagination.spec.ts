import { describe, it, expect } from 'vitest';
import { clampLimit, toPage } from './pagination';

describe('clampLimit', () => {
  it('default 25 si no se pasa o NaN', () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit(Number.NaN)).toBe(25);
  });
  it('clamp a [1, 100]', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(50)).toBe(50);
  });
  it('trunca fracciones', () => {
    expect(clampLimit(10.9)).toBe(10);
  });
});

describe('toPage', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));

  it('sin más filas que el límite → nextCursor null', () => {
    const page = toPage(rows(3), 5);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
  it('exactamente el límite → nextCursor null (no se trajo la fila extra)', () => {
    const page = toPage(rows(5), 5);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });
  it('más filas que el límite (take=limit+1) → recorta y devuelve cursor = id de la última devuelta', () => {
    const page = toPage(rows(6), 5);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBe('id-4'); // última de las 5 devueltas
  });
  it('vacío → sin items ni cursor', () => {
    const page = toPage([], 5);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
