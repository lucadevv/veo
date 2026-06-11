import {
  canStartShift,
  isOnShift,
  isSuspended,
  parseShiftStatus,
} from '../value-objects/shift-status';

describe('shift-status', () => {
  it('reconoce los estados reales del backend (enum canónico DriverStatus)', () => {
    expect(parseShiftStatus('AVAILABLE')).toBe('AVAILABLE');
    expect(parseShiftStatus('ASSIGNED')).toBe('ASSIGNED');
    expect(parseShiftStatus('ON_BREAK')).toBe('ON_BREAK');
    expect(parseShiftStatus('ON_TRIP')).toBe('ON_TRIP');
    expect(parseShiftStatus('OFFLINE')).toBe('OFFLINE');
    // SUSPENDED es estado conocido: antes faltaba y caía a UNKNOWN (raíz del hallazgo #1).
    expect(parseShiftStatus('SUSPENDED')).toBe('SUSPENDED');
  });

  it('mapea desconocidos a UNKNOWN', () => {
    expect(parseShiftStatus('WHATEVER')).toBe('UNKNOWN');
    expect(parseShiftStatus('')).toBe('UNKNOWN');
  });

  it('isOnShift para disponible, asignado o en viaje', () => {
    expect(isOnShift('AVAILABLE')).toBe(true);
    expect(isOnShift('ASSIGNED')).toBe(true);
    expect(isOnShift('ON_TRIP')).toBe(true);
    expect(isOnShift('ON_BREAK')).toBe(false);
    expect(isOnShift('OFFLINE')).toBe(false);
    expect(isOnShift('SUSPENDED')).toBe(false);
  });

  it('isSuspended solo para SUSPENDED', () => {
    expect(isSuspended('SUSPENDED')).toBe(true);
    expect(isSuspended('OFFLINE')).toBe(false);
    expect(isSuspended('UNKNOWN')).toBe(false);
  });

  it('canStartShift SOLO desde offline o pausa (seguridad: NO desde suspendido ni desconocido)', () => {
    expect(canStartShift('OFFLINE')).toBe(true);
    expect(canStartShift('ON_BREAK')).toBe(true);
    // Regla de seguridad (hallazgo #1): un suspendido jamás opera.
    expect(canStartShift('SUSPENDED')).toBe(false);
    // Conservador: con el enum canónico completo, UNKNOWN = drift/corrupción del contrato. No se
    // arranca turno desde un estado que no podemos razonar (la UI refleja, el server es el backstop).
    expect(canStartShift('UNKNOWN')).toBe(false);
    expect(canStartShift('AVAILABLE')).toBe(false);
    expect(canStartShift('ASSIGNED')).toBe(false);
    expect(canStartShift('ON_TRIP')).toBe(false);
  });
});
