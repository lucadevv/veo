import {canStartShift, isOnShift, parseShiftStatus} from '../value-objects/shift-status';

describe('shift-status', () => {
  it('reconoce los estados reales del backend', () => {
    expect(parseShiftStatus('AVAILABLE')).toBe('AVAILABLE');
    expect(parseShiftStatus('ON_BREAK')).toBe('ON_BREAK');
    expect(parseShiftStatus('ON_TRIP')).toBe('ON_TRIP');
    expect(parseShiftStatus('OFFLINE')).toBe('OFFLINE');
  });

  it('mapea desconocidos a UNKNOWN', () => {
    expect(parseShiftStatus('WHATEVER')).toBe('UNKNOWN');
    expect(parseShiftStatus('')).toBe('UNKNOWN');
  });

  it('isOnShift solo para disponible o en viaje', () => {
    expect(isOnShift('AVAILABLE')).toBe(true);
    expect(isOnShift('ON_TRIP')).toBe(true);
    expect(isOnShift('ON_BREAK')).toBe(false);
    expect(isOnShift('OFFLINE')).toBe(false);
  });

  it('canStartShift desde offline/pausa/desconocido', () => {
    expect(canStartShift('OFFLINE')).toBe(true);
    expect(canStartShift('ON_BREAK')).toBe(true);
    expect(canStartShift('UNKNOWN')).toBe(true);
    expect(canStartShift('AVAILABLE')).toBe(false);
    expect(canStartShift('ON_TRIP')).toBe(false);
  });
});
