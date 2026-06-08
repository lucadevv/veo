import {isTripActive, parseTripStatus} from '../value-objects/trip-status';

describe('trip-status', () => {
  it('parsea estados válidos del contrato', () => {
    expect(parseTripStatus('ACCEPTED')).toBe('ACCEPTED');
    expect(parseTripStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(parseTripStatus('COMPLETED')).toBe('COMPLETED');
  });

  it('mapea desconocidos a UNKNOWN', () => {
    expect(parseTripStatus('FOO')).toBe('UNKNOWN');
  });

  it('isTripActive es falso para terminales/desconocidos', () => {
    expect(isTripActive('ACCEPTED')).toBe(true);
    expect(isTripActive('ARRIVING')).toBe(true);
    expect(isTripActive('IN_PROGRESS')).toBe(true);
    expect(isTripActive('COMPLETED')).toBe(false);
    expect(isTripActive('CANCELLED')).toBe(false);
    expect(isTripActive('UNKNOWN')).toBe(false);
  });
});
