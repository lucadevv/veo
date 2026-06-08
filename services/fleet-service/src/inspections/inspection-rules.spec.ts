import { describe, it, expect } from 'vitest';
import { computeNextInspectionDue, isInspectionOverdue } from './inspection-rules';

describe('computeNextInspectionDue (BR-D04 — inspección trimestral)', () => {
  it('suma 3 meses por defecto', () => {
    const inspectedAt = new Date('2026-01-15T10:00:00.000Z');
    expect(computeNextInspectionDue(inspectedAt).toISOString()).toBe('2026-04-15T10:00:00.000Z');
  });

  it('cruza el fin de año correctamente', () => {
    const inspectedAt = new Date('2026-11-30T00:00:00.000Z');
    const next = computeNextInspectionDue(inspectedAt);
    // 30 de noviembre + 3 meses → febrero (sin día 30) → desborda a marzo (calendario JS).
    expect(next.getUTCFullYear()).toBe(2027);
    expect(next > inspectedAt).toBe(true);
  });

  it('respeta un intervalo configurable', () => {
    const inspectedAt = new Date('2026-01-15T00:00:00.000Z');
    expect(computeNextInspectionDue(inspectedAt, 6).toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('no muta la fecha de entrada', () => {
    const inspectedAt = new Date('2026-01-15T00:00:00.000Z');
    const snapshot = inspectedAt.getTime();
    computeNextInspectionDue(inspectedAt);
    expect(inspectedAt.getTime()).toBe(snapshot);
  });
});

describe('isInspectionOverdue', () => {
  it('vencida si nextDueAt ya pasó', () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    expect(isInspectionOverdue(new Date('2026-05-27T00:00:00.000Z'), now)).toBe(true);
    expect(isInspectionOverdue(new Date('2026-06-01T00:00:00.000Z'), now)).toBe(false);
  });
});
