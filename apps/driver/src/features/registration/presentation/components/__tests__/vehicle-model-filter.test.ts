import { filterVehicleModels } from '../vehicle-model-filter';
import type { VehicleModelOption } from '../../../domain';

const models: VehicleModelOption[] = [
  {
    id: '1',
    make: 'Toyota',
    model: 'Yaris',
    yearFrom: 2017,
    yearTo: 2024,
    vehicleType: 'CAR',
    seats: 5,
  },
  {
    id: '2',
    make: 'Hyundai',
    model: 'i10',
    yearFrom: 2018,
    yearTo: 2024,
    vehicleType: 'CAR',
    seats: 5,
  },
  {
    id: '3',
    make: 'Bajaj',
    model: 'RE',
    yearFrom: 2018,
    yearTo: 2024,
    vehicleType: 'MOTO',
    seats: 3,
  },
];

describe('filterVehicleModels (búsqueda client-side del selector · B5-2)', () => {
  it('query vacía → la lista completa (copia, no la misma referencia)', () => {
    const out = filterVehicleModels(models, '   ');
    expect(out).toHaveLength(3);
    expect(out).not.toBe(models);
  });

  it('matchea por MARCA, case-insensitive', () => {
    expect(filterVehicleModels(models, 'toyo').map((m) => m.id)).toEqual(['1']);
    expect(filterVehicleModels(models, 'BAJAJ').map((m) => m.id)).toEqual(['3']);
  });

  it('matchea por MODELO, case-insensitive', () => {
    expect(filterVehicleModels(models, 'i10').map((m) => m.id)).toEqual(['2']);
    expect(filterVehicleModels(models, 'yar').map((m) => m.id)).toEqual(['1']);
  });

  it('sin coincidencias → []', () => {
    expect(filterVehicleModels(models, 'tesla')).toEqual([]);
  });
});
