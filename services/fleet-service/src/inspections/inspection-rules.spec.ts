import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  computeNextInspectionDue,
  isInspectionOverdue,
  isInspectionCurrent,
  inspectionInvalidReason,
  InspectionInvalidReason,
  assertInspectedAtNotFuture,
} from './inspection-rules';

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

describe('isInspectionCurrent (vigencia ITV: passed && no vencida)', () => {
  const now = new Date('2026-05-28T12:00:00.000Z');

  it('vigente: passed=true y nextDueAt futuro', () => {
    expect(isInspectionCurrent({ passed: true, nextDueAt: new Date('2026-08-01T00:00:00.000Z') }, now)).toBe(true);
  });

  it('NO vigente: reprobada (passed=false) aunque no esté vencida', () => {
    expect(isInspectionCurrent({ passed: false, nextDueAt: new Date('2026-08-01T00:00:00.000Z') }, now)).toBe(false);
  });

  it('NO vigente: vencida (nextDueAt pasado) aunque passed=true', () => {
    expect(isInspectionCurrent({ passed: true, nextDueAt: new Date('2026-05-27T00:00:00.000Z') }, now)).toBe(false);
  });

  it('NO vigente: sin inspección (null)', () => {
    expect(isInspectionCurrent(null, now)).toBe(false);
  });
});

describe('inspectionInvalidReason (motivo tipado de invalidez)', () => {
  const now = new Date('2026-05-28T12:00:00.000Z');

  it('null cuando es vigente', () => {
    expect(inspectionInvalidReason({ passed: true, nextDueAt: new Date('2026-08-01T00:00:00.000Z') }, now)).toBeNull();
  });

  it('NONE sin inspección', () => {
    expect(inspectionInvalidReason(null, now)).toBe(InspectionInvalidReason.NONE);
  });

  it('NOT_PASSED si reprobó (precede a vencida)', () => {
    // reprobada Y vencida → NOT_PASSED gana por precedencia.
    expect(
      inspectionInvalidReason({ passed: false, nextDueAt: new Date('2026-05-01T00:00:00.000Z') }, now),
    ).toBe(InspectionInvalidReason.NOT_PASSED);
  });

  it('OVERDUE si passed pero vencida', () => {
    expect(
      inspectionInvalidReason({ passed: true, nextDueAt: new Date('2026-05-27T00:00:00.000Z') }, now),
    ).toBe(InspectionInvalidReason.OVERDUE);
  });
});

describe('assertInspectedAtNotFuture (anti-futuro · gate auto-atestable)', () => {
  const now = new Date('2026-06-21T12:00:00.000Z');

  it('RECHAZA (ValidationError tipado) un inspectedAt futuro', () => {
    const future = new Date('2026-06-21T12:00:01.000Z');
    expect(() => assertInspectedAtNotFuture(future, now)).toThrow(ValidationError);
  });

  it('ACEPTA inspectedAt = now (límite inclusivo)', () => {
    expect(() => assertInspectedAtNotFuture(new Date(now), now)).not.toThrow();
  });

  it('ACEPTA inspectedAt pasado', () => {
    expect(() =>
      assertInspectedAtNotFuture(new Date('2026-01-01T00:00:00.000Z'), now),
    ).not.toThrow();
  });
});
