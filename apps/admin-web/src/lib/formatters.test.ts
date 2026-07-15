import { describe, expect, it } from 'vitest';
import { date, dateTime, duration, money } from './formatters';

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

  it('dateTime trata un date-only (YYYY-MM-DD) como día de calendario, SIN hora ni desfase de TZ', () => {
    // Regresión: `2027-06-13` se mostraba como "12/06/2027, 07:00 p. m." (medianoche UTC → -5h Perú).
    // Ahora se trata como fecha de calendario: mismo día, sin hora.
    expect(dateTime('2027-06-13')).toBe('13/06/2027');
  });

  it('dateTime conserva fecha + hora para un timestamp real (con hora)', () => {
    // Un instante con offset explícito NO es date-only: mantiene el formato fecha + hora local.
    const formatted = dateTime('2026-05-29T05:49:00.000Z');
    expect(formatted).toMatch(/29\/05\/2026/);
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });

  it('date formatea un vencimiento date-only sin hora ni desfase de TZ', () => {
    expect(date('2027-06-13')).toBe('13/06/2027');
    expect(date(null)).toBe('—');
    expect(date('no-es-fecha')).toBe('—');
  });

  it('date ancla a UTC el vencimiento que llega como timestamp midnight-UTC (path REAL de @db.Timestamptz)', () => {
    // Regresión (auditar-core): expiresAt se persiste como Timestamptz → llega '2027-06-13T00:00:00.000Z'
    // (con T). En Perú (UTC-5) renderizar en local mostraba 12/06/2027 (un día antes). Ahora date() ancla
    // SIEMPRE a UTC → el día de calendario correcto, sin importar si vino date-only o timestamp.
    expect(date('2027-06-13T00:00:00.000Z')).toBe('13/06/2027');
    expect(date('2032-10-17T00:00:00.000Z')).toBe('17/10/2032');
  });
});
