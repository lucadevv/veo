/** Test de las ventanas temporales (UTC) del desglose de ganancias. */
import { describe, it, expect } from 'vitest';
import { dayWindow, monthWindow, weekDailyWindows, weekWindow } from './earnings.windows';

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

describe('monthWindow', () => {
  it('acota el mes calendario UTC que contiene a now', () => {
    // Miércoles 2026-05-27 → mayo 2026.
    const { start, end } = monthWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('el día 1 a las 00:00 pertenece a su propio mes (start = ese día)', () => {
    const { start, end } = monthWindow(new Date('2026-05-01T00:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('diciembre rueda al enero del año siguiente (cambio de año)', () => {
    const { start, end } = monthWindow(new Date('2026-12-15T09:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('weekDailyWindows', () => {
  it('devuelve 7 días naturales lunes→domingo, contiguos', () => {
    // Miércoles 2026-05-27 → semana del lunes 2026-05-25.
    const windows = weekDailyWindows(new Date('2026-05-27T14:30:00.000Z'));
    expect(windows).toHaveLength(7);
    const iso = windows.map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
    expect(iso[0]?.start).toBe('2026-05-25T00:00:00.000Z'); // lunes
    expect(iso[6]?.start).toBe('2026-05-31T00:00:00.000Z'); // domingo
    // Cada día dura exactamente 24h.
    for (const w of windows) {
      expect(w.end.getTime() - w.start.getTime()).toBe(24 * 60 * 60 * 1000);
    }
    // Contiguos: el fin de cada día coincide con el inicio del siguiente.
    for (let i = 1; i < iso.length; i += 1) {
      expect(iso[i]?.start).toBe(iso[i - 1]?.end);
    }
  });

  it('cubre exactamente weekWindow (primer start y último end)', () => {
    const now = new Date('2026-05-27T14:30:00.000Z');
    const windows = weekDailyWindows(now);
    const week = weekWindow(now);
    const iso = windows.map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
    expect(iso[0]?.start).toBe(week.start.toISOString());
    expect(iso[6]?.end).toBe(week.end.toISOString());
  });
});
