import { validatePersonalData } from '../usecases/update-personal-data';
import { validateVehicle } from '../usecases/register-vehicle';
import type { PersonalData, VehicleData } from '../entities';

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
    const result = validatePersonalData({ ...basePersonal, dni: '1234' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.dni).toBe('dni_invalid');
    }
  });

  it('rechaza nombre vacío y fecha inválida', () => {
    const result = validatePersonalData({
      fullName: '   ',
      dni: '70123456',
      birthdate: '32/13/1990',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.fullName).toBe('name_required');
      expect(result.errors.birthdate).toBe('birthdate_invalid');
    }
  });

  it('acepta la fecha de nacimiento ya en ISO yyyy-mm-dd (la que emite el DateField nativo)', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: '1990-08-15' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.birthDate).toBe('1990-08-15');
    }
  });

  it('rechaza una fecha ISO anterior al año mínimo (1920)', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: '1919-12-31' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_invalid');
    }
  });

  it('rechaza una fecha ISO inexistente (29 feb de año no bisiesto)', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: '2021-02-29' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_invalid');
    }
  });

  it('rechaza una fecha ISO futura', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const iso = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(
      2,
      '0',
    )}-${String(future.getUTCDate()).padStart(2, '0')}`;
    const result = validatePersonalData({ ...basePersonal, birthdate: iso });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_future');
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

describe('validatePersonalData · regla de edad (BR-I04, espejo del backend)', () => {
  // Construye un ISO yyyy-mm-dd a partir de "hoy" (UTC) desplazado por años/días, para tests
  // deterministas que dependen de la fecha actual (igual criterio que el backend: comparación UTC).
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const isoFromTodayUtc = (deltaYears: number, deltaDays = 0): string => {
    const today = new Date();
    const d = new Date(
      Date.UTC(today.getUTCFullYear() + deltaYears, today.getUTCMonth(), today.getUTCDate()),
    );
    if (deltaDays !== 0) {
      d.setUTCDate(d.getUTCDate() + deltaDays);
    }
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };

  it('acepta exactamente 18 años cumplidos hoy (cumple 18 hoy)', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: isoFromTodayUtc(-18) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.birthDate).toBe(isoFromTodayUtc(-18));
    }
  });

  it('rechaza 17 años y 364 días (cumple 18 mañana) como underage', () => {
    // Hoy menos 18 años, más 1 día → aún no cumplió 18.
    const result = validatePersonalData({ ...basePersonal, birthdate: isoFromTodayUtc(-18, 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_underage');
    }
  });

  it('acepta exactamente 100 años cumplidos hoy', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: isoFromTodayUtc(-100) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.birthDate).toBe(isoFromTodayUtc(-100));
    }
  });

  it('rechaza 101 años (un día antes de cumplir 100 sería válido; 101 no) como invalid_age', () => {
    // Hoy menos 100 años, menos 1 día → ya tiene 100 años + 1 día... usamos -101 para >100 claro.
    const result = validatePersonalData({ ...basePersonal, birthdate: isoFromTodayUtc(-101) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.birthdate).toBe('birthdate_invalid_age');
    }
  });

  it('rechaza una fecha futura antes de evaluar la edad', () => {
    const result = validatePersonalData({ ...basePersonal, birthdate: isoFromTodayUtc(1) });
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
    const result = validateVehicle({ ...baseVehicle, plate: '12' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.plate).toBe('plate_invalid');
    }
  });

  it('rechaza año fuera de rango', () => {
    const result = validateVehicle({ ...baseVehicle, year: '1990' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.year).toBe('year_invalid');
    }
  });

  it('RAMA TEXTO LIBRE (Lote 2 · scan-first): sin modelSpecId pero con make+model → envía make/model', () => {
    // Tarjeta escaneada: el OCR dejó marca/modelo a texto libre y NO hay modelSpecId (catálogo no tocado).
    // El contrato (`registerVehicleRequest.refine`) acepta esta rama; el body lleva make+model, no modelSpecId.
    const result = validateVehicle({ ...baseVehicle, modelSpecId: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toEqual({
        vehicleType: 'MOTO',
        plate: 'ABC-123',
        year: 2021,
        make: 'Honda',
        model: 'CB 190R',
      });
    }
  });

  it('rechaza si no hay NI modelo del catálogo NI marca/modelo a texto libre', () => {
    const result = validateVehicle({ ...baseVehicle, modelSpecId: '', brand: '', model: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.model).toBe('model_not_selected');
    }
  });
});
