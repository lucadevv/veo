import {
  DEFAULT_VEHICLE_TYPE,
  VEHICLE_TYPES,
  parseVehicleType,
} from '../value-objects/vehicle-type';

describe('vehicle-type', () => {
  it('el tipo por defecto es CAR (compat con dispatch)', () => {
    expect(DEFAULT_VEHICLE_TYPE).toBe('CAR');
  });

  it('expone Auto y Moto en orden de presentación', () => {
    expect(VEHICLE_TYPES).toEqual(['CAR', 'MOTO']);
  });

  it('reconoce los tipos válidos', () => {
    expect(parseVehicleType('CAR')).toBe('CAR');
    expect(parseVehicleType('MOTO')).toBe('MOTO');
  });

  it('degrada a CAR ante valores ausentes, vacíos o corruptos', () => {
    expect(parseVehicleType(undefined)).toBe('CAR');
    expect(parseVehicleType(null)).toBe('CAR');
    expect(parseVehicleType('')).toBe('CAR');
    expect(parseVehicleType('car')).toBe('CAR');
    expect(parseVehicleType('TRUCK')).toBe('CAR');
  });
});
