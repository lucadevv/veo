/**
 * Tests unitarios PUROS del hash chain (sin DB): construcción de cadena válida y
 * detección de tampering (alteración de contenido y ruptura de enlace).
 */
import { describe, it, expect } from 'vitest';
import {
  computeEntryHash,
  serializeAuditEntry,
  verifyChain,
  type AuditEntryContent,
  type ChainRow,
} from './chain';

function content(i: number, overrides: Partial<AuditEntryContent> = {}): AuditEntryContent {
  return {
    eventId: `evt-${i}`,
    actorId: `actor-${i}`,
    action: 'test.action',
    resourceType: 'trip',
    resourceId: `trip-${i}`,
    ip: '10.0.0.1',
    userAgent: 'vitest',
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000),
    payload: { i, note: 'hola' },
    ...overrides,
  };
}

/** Construye una cadena correcta de N filas (como lo haría el repositorio). */
function buildChain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prevHash: string | null = null;
  for (let i = 1; i <= n; i++) {
    const c = content(i);
    const hash = computeEntryHash(prevHash, c);
    rows.push({ ...c, seq: i, prevHash, hash });
    prevHash = hash;
  }
  return rows;
}

describe('serializeAuditEntry', () => {
  it('es determinista e independiente del orden de claves del payload', () => {
    const a = content(1, { payload: { a: 1, b: 2, nested: { x: 1, y: 2 } } });
    const b = content(1, { payload: { nested: { y: 2, x: 1 }, b: 2, a: 1 } });
    expect(serializeAuditEntry(a)).toBe(serializeAuditEntry(b));
  });

  it('normaliza occurredAt (Date o string ISO producen el mismo hash)', () => {
    const asDate = content(1, { occurredAt: new Date('2026-01-01T00:00:01.000Z') });
    const asString = content(1, { occurredAt: '2026-01-01T00:00:01.000Z' });
    expect(computeEntryHash(null, asDate)).toBe(computeEntryHash(null, asString));
  });
});

describe('verifyChain — cadena válida', () => {
  it('valida una cadena íntegra desde GENESIS', () => {
    const rows = buildChain(50);
    const result = verifyChain(rows, { expectGenesis: true });
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(50);
  });

  it('la primera entrada tiene prevHash null (GENESIS)', () => {
    const rows = buildChain(3);
    expect(rows[0]!.prevHash).toBeNull();
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.hash);
  });

  it('valida un rango parcial (no exige GENESIS)', () => {
    const rows = buildChain(10).slice(4); // seqs 5..10
    const result = verifyChain(rows, { expectGenesis: false });
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(6);
  });
});

describe('verifyChain — detección de tampering', () => {
  it('detecta alteración del payload de una entrada (CONTENT_TAMPERED)', () => {
    const rows = buildChain(20);
    // Un atacante altera el payload de la fila 10 SIN recalcular el hash.
    const tampered = rows.map((r) =>
      r.seq === 10 ? { ...r, payload: { ...r.payload, note: 'ALTERADO' } } : r,
    );
    const result = verifyChain(tampered, { expectGenesis: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CONTENT_TAMPERED');
    expect(result.brokenAtSeq).toBe('10');
  });

  it('detecta alteración del actorId', () => {
    const rows = buildChain(5);
    const tampered = rows.map((r) => (r.seq === 3 ? { ...r, actorId: 'intruso' } : r));
    const result = verifyChain(tampered, { expectGenesis: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CONTENT_TAMPERED');
    expect(result.brokenAtSeq).toBe('3');
  });

  it('detecta una entrada eliminada (ruptura de enlace, BROKEN_LINK)', () => {
    const rows = buildChain(10);
    // Eliminar la fila seq=5 rompe el enlace: la fila 6 apunta a un hash que ya no precede.
    const withGap = rows.filter((r) => r.seq !== 5);
    const result = verifyChain(withGap, { expectGenesis: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('BROKEN_LINK');
    expect(result.brokenAtSeq).toBe('6');
  });

  it('detecta un hash recalculado por el atacante pero con enlace inconsistente', () => {
    const rows = buildChain(8);
    // El atacante altera el payload de la fila 4 y recalcula SU hash (para pasar CONTENT),
    // pero no puede arreglar el resto: la fila 5 sigue apuntando al hash original.
    const idx = 3;
    const altered = { ...rows[idx]!, payload: { hacked: true } };
    altered.hash = computeEntryHash(altered.prevHash, altered);
    const tampered = rows.map((r, i) => (i === idx ? altered : r));
    const result = verifyChain(tampered, { expectGenesis: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('BROKEN_LINK');
    expect(result.brokenAtSeq).toBe('5');
  });
});
