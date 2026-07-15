/**
 * Test de las ventanas temporales del desglose de ganancias, ancladas a America/Lima (UTC-5 fijo).
 * Medianoche de Lima = 05:00Z del mismo día calendario.
 */
import { describe, it, expect } from 'vitest';
import { dayWindow, monthWindow, weekDailyWindows, weekWindow } from './earnings.windows';

describe('dayWindow', () => {
  it('acota el día natural de LIMA que contiene a now', () => {
    // Miércoles 2026-05-27 14:30Z = 09:30 en Lima → día Lima del 27: [27 05:00Z, 28 05:00Z).
    const { start, end } = dayWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-27T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-28T05:00:00.000Z');
  });

  it('la noche de Lima sigue siendo HOY aunque en UTC ya sea mañana (regresión del neto congelado)', () => {
    // 2026-07-14 03:46Z = 22:46 del 13 en Lima → la ventana es el día Lima del 13, no el 14 UTC.
    const { start, end } = dayWindow(new Date('2026-07-14T03:46:00.000Z'));
    expect(start.toISOString()).toBe('2026-07-13T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-14T05:00:00.000Z');
    // Un cobro capturado a las 20:14 de Lima (01:14Z del día UTC siguiente) cae DENTRO de hoy.
    const captured = new Date('2026-07-14T01:14:00.000Z').getTime();
    expect(captured >= start.getTime() && captured < end.getTime()).toBe(true);
  });

  it('la madrugada UTC previa a las 05:00Z pertenece al día Lima ANTERIOR', () => {
    // 2026-05-27 02:00Z = 21:00 del 26 en Lima.
    const { start } = dayWindow(new Date('2026-05-27T02:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-26T05:00:00.000Z');
  });
});

describe('weekWindow', () => {
  it('acota la semana [lunes, lunes+7) de Lima que contiene a now', () => {
    // Miércoles 2026-05-27 (Lima) → semana del lunes 2026-05-25 Lima.
    const { start, end } = weekWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('un lunes de Lima pertenece a su propia semana (start = ese lunes)', () => {
    // 2026-05-25 05:00Z = lunes 00:00 en Lima.
    const { start } = weekWindow(new Date('2026-05-25T05:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T05:00:00.000Z');
  });

  it('el domingo a la noche en Lima pertenece a la semana del lunes anterior (en UTC ya es lunes)', () => {
    // 2026-06-01 02:00Z = domingo 31 21:00 en Lima.
    const { start, end } = weekWindow(new Date('2026-06-01T02:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-25T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });
});

describe('monthWindow', () => {
  it('acota el mes calendario de Lima que contiene a now', () => {
    // Miércoles 2026-05-27 (Lima) → mayo 2026 Lima.
    const { start, end } = monthWindow(new Date('2026-05-27T14:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('la madrugada UTC del día 1 pertenece al mes Lima ANTERIOR (aún es fin de mes en Lima)', () => {
    // 2026-06-01 02:00Z = 31 de mayo 21:00 en Lima.
    const { start, end } = monthWindow(new Date('2026-06-01T02:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-05-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('diciembre rueda al enero del año siguiente (cambio de año)', () => {
    const { start, end } = monthWindow(new Date('2026-12-15T09:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
});

describe('weekDailyWindows', () => {
  it('devuelve 7 días naturales de Lima lunes→domingo, contiguos', () => {
    // Miércoles 2026-05-27 (Lima) → semana del lunes 2026-05-25 Lima.
    const windows = weekDailyWindows(new Date('2026-05-27T14:30:00.000Z'));
    expect(windows).toHaveLength(7);
    const iso = windows.map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
    expect(iso[0]?.start).toBe('2026-05-25T05:00:00.000Z'); // lunes 00:00 Lima
    expect(iso[6]?.start).toBe('2026-05-31T05:00:00.000Z'); // domingo 00:00 Lima
    // Cada día dura exactamente 24h (offset fijo, sin DST).
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

  it('el label YYYY-MM-DD de cada start (medianoche Lima) coincide con el día calendario de Lima', () => {
    // Contrato del bar chart: `daily()` etiqueta con start.toISOString().slice(0,10).
    const windows = weekDailyWindows(new Date('2026-05-27T14:30:00.000Z'));
    const labels = windows.map((w) => w.start.toISOString().slice(0, 10));
    expect(labels).toEqual([
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
      '2026-05-28',
      '2026-05-29',
      '2026-05-30',
      '2026-05-31',
    ]);
  });
});
