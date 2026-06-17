import {validatePersonalData} from '../usecases/update-personal-data';
import {validateVehicle} from '../usecases/register-vehicle';
import type {PersonalData, VehicleData} from '../entities';

const basePersonal: PersonalData = {
  fullName: 'Carlos Quispe Mamani',
  dni: '70 123 456',
  birthdate: '15/08/1990',
};

const baseVehicle: VehicleData = {
  type: 'MOTO',
  plate: 'abc-123',
  year: '2021',
  // B5-2: el modelo se elige del catálogo; modelSpecId es lo que viaja al backend.
  modelSpecId: 'spec-123',
  brand: 'Honda',
  model: 'CB 190R',
};

describe('validatePersonalData', () => {
  it('normaliza DNI (sin espacios) y convierte la fecha a yyyy-mm-dd', () => {
    const result = validatePersonalData(basePersonal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toEqual({
        legalName: 'Carlos Quispe Mamani',
        dni: '70123456',
        birthDate: '1990-08-15',
      });
    }
  });

  it('rechaza DNI que no tenga 8 dígitos', () => {
    const result = validatePersonalData({...basePersonal, dni: '1234'});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.dni).toBe('dni_invalid');
    }
  });

  it('rechaza nombre vacío y fecha inválida', () => {
    const result = validatePersonalData({fullName: '   ', dni: '70123456', birthdate: '32/13/1990'});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.fullName).toBe('name_required');
      expect(result.errors.birthdate).toBe('birthdate_invalid');
    }
  });

  it('rechaza fecha de nacimiento futura', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const dd = String(future.getUTCDate()).padStart(2, '0');
    const mm = String(future.getUTCMonth() + 1).padStart(2, '0');
    const result = validatePersonalData({
      ...basePersonal,
      birthdate: `${dd}/${mm}/${future.getUTCFullYear()}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_future');
    }
  });
});

describe('validateVehicle', () => {
  it('normaliza la placa (mayúsculas), convierte el año y envía modelSpecId (no make/model libre)', () => {
    const result = validateVehicle(baseVehicle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toEqual({
        vehicleType: 'MOTO',
        plate: 'ABC-123',
        modelSpecId: 'spec-123',
        year: 2021,
      });
    }
  });

  it('rechaza placa con formato inválido', () => {
    const result = validateVehicle({...baseVehicle, plate: '12'});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.plate).toBe('plate_invalid');
    }
  });

  it('rechaza año fuera de rango', () => {
    const result = validateVehicle({...baseVehicle, year: '1990'});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.year).toBe('year_invalid');
    }
  });

  it('rechaza si no se eligió un modelo del catálogo (modelSpecId vacío)', () => {
    const result = validateVehicle({...baseVehicle, modelSpecId: '   '});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.model).toBe('model_not_selected');
    }
  });
});
