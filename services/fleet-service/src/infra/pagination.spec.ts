import { describe, it, expect } from 'vitest';
import {
  clampLimit,
  toPage,
  toExpiryPage,
  encodeExpiryCursor,
  decodeExpiryCursor,
} from './pagination';

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

describe('cursor compuesto (expiresAt, id) · cola de vencimientos', () => {
  const at = new Date('2026-07-10T00:00:00.000Z');

  it('encode → ISO|id; decode lo invierte (round-trip)', () => {
    const cursor = encodeExpiryCursor({ expiresAt: at, id: 'doc-1' });
    expect(cursor).toBe('2026-07-10T00:00:00.000Z|doc-1');
    const decoded = decodeExpiryCursor(cursor);
    expect(decoded?.id).toBe('doc-1');
    expect(decoded?.expiresAt.toISOString()).toBe(at.toISOString());
  });

  it('decode rechaza formatos inválidos → null', () => {
    expect(decodeExpiryCursor('')).toBeNull();
    expect(decodeExpiryCursor('sin-separador')).toBeNull();
    expect(decodeExpiryCursor('|doc-1')).toBeNull(); // sin fecha
    expect(decodeExpiryCursor('2026-07-10T00:00:00.000Z|')).toBeNull(); // sin id
    expect(decodeExpiryCursor('no-es-fecha|doc-1')).toBeNull(); // fecha inválida
  });

  it('toExpiryPage: con más filas que el límite → nextCursor = tupla de la última devuelta', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `doc-${i}`,
      expiresAt: new Date(at.getTime() + i * 86_400_000),
    }));
    const page = toExpiryPage(rows, 5);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBe(`${rows[4]!.expiresAt.toISOString()}|doc-4`);
  });

  it('toExpiryPage: sin más filas → nextCursor null', () => {
    const rows = [{ id: 'doc-0', expiresAt: at }];
    const page = toExpiryPage(rows, 5);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
