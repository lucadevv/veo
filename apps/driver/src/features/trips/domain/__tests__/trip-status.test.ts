import { isTripActive, isTripTerminal, parseTripStatus } from '../value-objects/trip-status';

describe('trip-status', () => {
  it('parsea estados válidos del contrato', () => {
    expect(parseTripStatus('ACCEPTED')).toBe('ACCEPTED');
    expect(parseTripStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(parseTripStatus('COMPLETED')).toBe('COMPLETED');
  });

  it('mapea desconocidos a UNKNOWN', () => {
    expect(parseTripStatus('FOO')).toBe('UNKNOWN');
  });

  it('isTripTerminal cubre TODOS los cierres (incl. watchdog y reasignación)', () => {
    expect(isTripTerminal('COMPLETED')).toBe(true);
    expect(isTripTerminal('CANCELLED')).toBe(true);
    expect(isTripTerminal('EXPIRED')).toBe(true);
    expect(isTripTerminal('FAILED')).toBe(true);
    expect(isTripTerminal('REASSIGNING')).toBe(true);
    expect(isTripTerminal('IN_PROGRESS')).toBe(false);
    expect(isTripTerminal('ACCEPTED')).toBe(false);
    // UNKNOWN no es terminal: no sabemos qué pasó, no limpiamos el viaje activo a ciegas.
    expect(isTripTerminal('UNKNOWN')).toBe(false);
  });

  it('isTripActive es falso para terminales/desconocidos', () => {
    expect(isTripActive('ACCEPTED')).toBe(true);
    expect(isTripActive('ARRIVING')).toBe(true);
    expect(isTripActive('IN_PROGRESS')).toBe(true);
    expect(isTripActive('COMPLETED')).toBe(false);
    expect(isTripActive('CANCELLED')).toBe(false);
    // Antes (bug #4) devolvían true: el watchdog/reasignación quedaban "activos".
    expect(isTripActive('EXPIRED')).toBe(false);
    expect(isTripActive('FAILED')).toBe(false);
    expect(isTripActive('REASSIGNING')).toBe(false);
    expect(isTripActive('UNKNOWN')).toBe(false);
  });
});
