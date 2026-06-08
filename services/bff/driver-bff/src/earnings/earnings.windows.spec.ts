/** Test de las ventanas temporales (UTC) del desglose de ganancias. */
import { describe, it, expect } from 'vitest';
import { dayWindow, weekWindow } from './earnings.windows';

describe('dayWindow', () => {
  it('acota el día natural UTC que contiene a now', () => {
    // Miércoles 2026-05-27 14:30 UTC
    const { start, end } = dayWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-28T00:00:00.000Z');
  });
});

describe('weekWindow', () => {
  it('acota la semana [lunes, lunes+7) que contiene a now', () => {
    // Miércoles 2026-05-27 → semana del lunes 2026-05-25.
    const { start, end } = weekWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('un lunes pertenece a su propia semana (start = ese lunes)', () => {
    const { start } = weekWindow(new Date('2026-05-25T00:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });

  it('un domingo pertenece a la semana del lunes anterior', () => {
    const { start, end } = weekWindow(new Date('2026-05-31T23:59:59.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});
