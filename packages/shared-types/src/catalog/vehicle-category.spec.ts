import { describe, expect, it } from 'vitest';
import { mapMtcCategoryToVehicleType } from './vehicle-category.js';
import { VehicleType } from '../enums/index.js';

describe('mapMtcCategoryToVehicleType (derivación de tipo desde la categoría MTC)', () => {
  it('M1 (auto de pasajeros estándar) → CAR', () => {
    expect(mapMtcCategoryToVehicleType('M1')).toBe(VehicleType.CAR);
  });

  it('clase L (vehículos menores: L1/L3/L5) → MOTO', () => {
    expect(mapMtcCategoryToVehicleType('L1')).toBe(VehicleType.MOTO);
    expect(mapMtcCategoryToVehicleType('L3')).toBe(VehicleType.MOTO);
    expect(mapMtcCategoryToVehicleType('L5')).toBe(VehicleType.MOTO);
  });

  it('tiers no soportados hoy (N1 carga, M2/M3 buses) → null (degradación honesta → manual)', () => {
    expect(mapMtcCategoryToVehicleType('N1')).toBeNull();
    expect(mapMtcCategoryToVehicleType('M2')).toBeNull();
    expect(mapMtcCategoryToVehicleType('M3')).toBeNull();
  });

  it('combinaciones especiales con sufijo (M1SC, L5SC: ambulancia/funerario…) → null', () => {
    expect(mapMtcCategoryToVehicleType('M1SC')).toBeNull();
    expect(mapMtcCategoryToVehicleType('L5SC')).toBeNull();
  });

  it('basura / vacío / no calza el patrón [LMNO]\\d[A-Z]* → null', () => {
    expect(mapMtcCategoryToVehicleType('')).toBeNull();
    expect(mapMtcCategoryToVehicleType('XYZ')).toBeNull();
    expect(mapMtcCategoryToVehicleType('<script>')).toBeNull();
  });

  it('tolera espacios y minúsculas del OCR (m1, " L3 ") → derivación correcta', () => {
    expect(mapMtcCategoryToVehicleType('m1')).toBe(VehicleType.CAR);
    expect(mapMtcCategoryToVehicleType(' L3 ')).toBe(VehicleType.MOTO);
  });
});
