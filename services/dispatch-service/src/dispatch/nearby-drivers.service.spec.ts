/**
 * Test del feed de conductores cercanos ANÓNIMOS (NearbyDriversService · mapa del pasajero "buscando").
 * Usa el doble en memoria del hot-index (mismo contrato que Redis). Verifica:
 *  - borde geográfico: fuera de Lima → vacío sin tocar el índice
 *  - anonimato + redondeo de coords (anti-rastreo)
 *  - tope MAX_NEARBY y orden por cercanía
 *  - filtro por vehicleType (válido filtra; inválido se ignora → todos)
 *  - vacío cuando no hay conductores
 */
import { describe, it, expect } from 'vitest';
import { toH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import { NearbyDriversService } from './nearby-drivers.service';
import { InMemoryHotIndex } from '../hot-index/in-memory-hot-index';

const ORIGIN = { lat: -12.0464, lon: -77.0428 }; // Lima centro
const CELL = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);

function makeService() {
  const hotIndex = new InMemoryHotIndex();
  const service = new NearbyDriversService(hotIndex);
  return { service, hotIndex };
}

describe('NearbyDriversService · feed de ambiente (anónimo)', () => {
  it('origen fuera de Lima → vacío (no consulta el índice)', async () => {
    const { service, hotIndex } = makeService();
    // Hay un conductor, pero el origen está en Buenos Aires (fuera del bounding box de Lima).
    await hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CELL);
    const out = await service.nearby({ lat: -34.6037, lon: -58.3816 });
    expect(out).toEqual([]);
  });

  it('coords NaN → vacío (borde no confiable)', async () => {
    const { service } = makeService();
    const out = await service.nearby({ lat: Number.NaN, lon: Number.NaN });
    expect(out).toEqual([]);
  });

  it('devuelve conductores anónimos (solo lat/lon/vehicleType, sin driverId)', async () => {
    const { service, hotIndex } = makeService();
    await hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, CELL, VehicleType.CAR);
    const out = await service.nearby(ORIGIN);
    expect(out).toHaveLength(1);
    const [v] = out;
    expect(Object.keys(v!).sort()).toEqual(['lat', 'lon', 'vehicleType']);
    expect(v).not.toHaveProperty('driverId');
    expect(v!.vehicleType).toBe(VehicleType.CAR);
  });

  it('redondea las coords a 3 decimales (~110m, anti-rastreo)', async () => {
    const { service, hotIndex } = makeService();
    // Coord con 6 decimales en la MISMA celda que el origen para que entre al k-ring.
    const raw = { lat: -12.046412, lon: -77.042834 };
    await hotIndex.seed('d1', raw.lat, raw.lon, CELL);
    const out = await service.nearby(ORIGIN);
    expect(out).toHaveLength(1);
    expect(out[0]!.lat).toBe(-12.046);
    expect(out[0]!.lon).toBe(-77.043);
  });

  it('capea a MAX_NEARBY (30) aunque haya más conductores en la celda', async () => {
    const { service, hotIndex } = makeService();
    for (let i = 0; i < 50; i++) {
      await hotIndex.seed(`d${i}`, ORIGIN.lat, ORIGIN.lon, CELL);
    }
    const out = await service.nearby(ORIGIN);
    expect(out).toHaveLength(30);
  });

  it('filtra por vehicleType cuando es un valor VÁLIDO del enum', async () => {
    const { service, hotIndex } = makeService();
    await hotIndex.seed('car1', ORIGIN.lat, ORIGIN.lon, CELL, VehicleType.CAR);
    await hotIndex.seed('moto1', ORIGIN.lat, ORIGIN.lon, CELL, VehicleType.MOTO);
    const out = await service.nearby(ORIGIN, VehicleType.MOTO);
    expect(out).toHaveLength(1);
    expect(out[0]!.vehicleType).toBe(VehicleType.MOTO);
  });

  it('ignora un vehicleType INVÁLIDO (devuelve todos los tipos, no vacío silencioso)', async () => {
    const { service, hotIndex } = makeService();
    await hotIndex.seed('car1', ORIGIN.lat, ORIGIN.lon, CELL, VehicleType.CAR);
    await hotIndex.seed('moto1', ORIGIN.lat, ORIGIN.lon, CELL, VehicleType.MOTO);
    const out = await service.nearby(ORIGIN, 'BASURA');
    expect(out).toHaveLength(2);
  });

  it('sin conductores cerca → lista vacía', async () => {
    const { service } = makeService();
    const out = await service.nearby(ORIGIN);
    expect(out).toEqual([]);
  });
});
