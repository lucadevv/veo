/**
 * OperableVehicleClassesProvider — el gate de operabilidad del alta lee el catálogo EFECTIVO del admin
 * (overlay-aware) en vez de la constante estática. Lo crítico:
 *  - deriva las clases operables del reply del catálogo (helper puro operableVehicleClasses);
 *  - una oferta MOTO habilitada por el admin → MOTO entra al set (deja de bloquear el alta de moto);
 *  - DEGRADACIÓN HONESTA: si trip-service tira, cae al default ESTÁTICO OPERABLE_VEHICLE_CLASSES (conservador),
 *    nunca propaga el error (el alta no se crashea por una config caída);
 *  - cachea un slot (TTL): dos lecturas seguidas pegan UNA vez al cliente interno.
 */
import { describe, it, expect, vi } from 'vitest';
import { OPERABLE_VEHICLE_CLASSES, VehicleClass } from '@veo/shared-types';
import { InternalRestClient } from '@veo/rpc';
import { OperableVehicleClassesProvider } from './operable-vehicle-classes.provider';

/** Doble del cliente REST interno (TRIP_REST): captura las llamadas a `get` y devuelve lo configurado. */
function makeTripRestDouble(get: ReturnType<typeof vi.fn>): InternalRestClient {
  return { get } as unknown as InternalRestClient;
}

const CATALOG_WITH_MOTO = {
  offerings: [
    { enabled: true, vehicleClass: VehicleClass.CAR },
    { enabled: true, vehicleClass: VehicleClass.MOTO },
  ],
};
const CATALOG_CAR_ONLY = {
  offerings: [
    { enabled: true, vehicleClass: VehicleClass.CAR },
    { enabled: false, vehicleClass: VehicleClass.MOTO },
  ],
};

describe('OperableVehicleClassesProvider (gate de operabilidad overlay-aware)', () => {
  it('el admin habilita MOTO por overlay → MOTO entra al set operable', async () => {
    const get = vi.fn().mockResolvedValue(CATALOG_WITH_MOTO);
    const provider = new OperableVehicleClassesProvider(makeTripRestDouble(get), 0);

    const classes = await provider.get();

    expect(classes).toContain(VehicleClass.MOTO);
    expect(classes).toContain(VehicleClass.CAR);
    // Pegó al endpoint interno del catálogo (mismo que el quote/createTrip).
    expect(get).toHaveBeenCalledWith('/internal/catalog', expect.objectContaining({ identity: expect.anything() }));
  });

  it('solo CAR habilitada (MOTO diferida) → [CAR], el gate sigue bloqueando MOTO', async () => {
    const get = vi.fn().mockResolvedValue(CATALOG_CAR_ONLY);
    const provider = new OperableVehicleClassesProvider(makeTripRestDouble(get), 0);

    const classes = await provider.get();

    expect([...classes]).toEqual([VehicleClass.CAR]);
    expect(classes).not.toContain(VehicleClass.MOTO);
  });

  it('DEGRADACIÓN HONESTA: trip-service caído → cae al default estático OPERABLE_VEHICLE_CLASSES, NO propaga', async () => {
    const get = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OperableVehicleClassesProvider(makeTripRestDouble(get), 0);

    const classes = await provider.get();

    // Conservador: ante incertidumbre, SOLO lo que el código shippeó por defecto (hoy [CAR]).
    expect([...classes]).toEqual([...OPERABLE_VEHICLE_CLASSES]);
  });

  it('cachea un slot: dos lecturas dentro del TTL pegan UNA sola vez al cliente interno', async () => {
    const get = vi.fn().mockResolvedValue(CATALOG_WITH_MOTO);
    const provider = new OperableVehicleClassesProvider(makeTripRestDouble(get), 30_000);

    await provider.get();
    await provider.get();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('el fallback degradado NO se cachea: se reintenta en la próxima lectura', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(CATALOG_WITH_MOTO);
    const provider = new OperableVehicleClassesProvider(makeTripRestDouble(get), 30_000);

    const first = await provider.get(); // degrada a estático
    const second = await provider.get(); // reintenta → catálogo con MOTO

    expect([...first]).toEqual([...OPERABLE_VEHICLE_CLASSES]);
    expect(second).toContain(VehicleClass.MOTO);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
