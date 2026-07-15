/**
 * Test de DriversService.setActiveVehicle (driver-bff) — ADR-017 §5(d) landmine d.2.
 *
 * El resolver del tipo/attrs del vehículo activo (ActiveVehicleTypeResolver) cachea por userId con TTL
 * corto para no resolver fleet en cada ping (por-segundo). Cuando el conductor hace SWAP de vehículo
 * activo, el PATCH a fleet por sí solo NO refleja el cambio en el ping hasta que vence el TTL (ventana
 * stale ≤ TTL_MS). setActiveVehicle debe INVALIDAR la cache del resolver tras el PATCH exitoso, y solo en
 * éxito: si el PATCH lanza, la invalidación NO corre (no se pierde la cache por un swap fallido).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { ActiveVehicleTypeResolver } from '../realtime/active-vehicle-type.resolver';
import { DriversService } from './drivers.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function makeService(opts: { patchRejects?: boolean } = {}) {
  const patch = vi.fn((_path: string, _opts: { identity: AuthenticatedUser; body: unknown }) =>
    opts.patchRejects
      ? Promise.reject(new Error('fleet down'))
      : Promise.resolve({
          id: 'veh-2',
          vehicleType: 'CAR',
          status: 'ACTIVE',
          plate: 'ABC-123',
        }),
  );
  const rest = { client: vi.fn(() => ({ patch, get: vi.fn(), post: vi.fn() })) };

  // Resolver REAL: probamos el efecto sobre su cache (no un mock de invalidate), para que el test pruebe la
  // intención —tras el swap, la próxima resolución NO devuelve el valor cacheado viejo— de punta a punta.
  const fleetGet = vi.fn();
  const resolverRest = { client: vi.fn(() => ({ get: fleetGet })) };
  const resolver = new ActiveVehicleTypeResolver(resolverRest as never);

  const config = {
    getOrThrow: vi.fn((key: string) => (key === 'S3_BUCKET_DOCUMENTS' ? 'veo-documents-dev' : 300)),
  };
  const service = new DriversService(
    {} as never,
    rest as never,
    resolver as never,
    config as never,
  );
  return { service, resolver, fleetGet, patch };
}

describe('DriversService.setActiveVehicle (driver-bff) — invalida la cache del resolver tras el swap (ADR-017 d.2)', () => {
  it('tras setActiveVehicle, la próxima resolución NO devuelve el valor cacheado viejo (cache invalidada → re-lee fleet)', async () => {
    const { service, resolver, fleetGet } = makeService();

    // 1) Primera resolución: fleet dice MOTO → se cachea para usr-1.
    fleetGet.mockResolvedValueOnce({ id: 'veh-1', vehicleType: 'MOTO' });
    const before = await resolver.resolve(identity, 'CAR');
    expect(before.vehicleType).toBe('MOTO');
    expect(before.vehicleId).toBe('veh-1');

    // 2) Segunda resolución SIN swap: viene de cache (fleet NO se vuelve a llamar).
    const cached = await resolver.resolve(identity, 'CAR');
    expect(cached.vehicleType).toBe('MOTO');
    expect(fleetGet).toHaveBeenCalledTimes(1);

    // 3) SWAP: el conductor pasa a su auto. setActiveVehicle invalida la cache del resolver.
    fleetGet.mockResolvedValueOnce({ id: 'veh-2', vehicleType: 'CAR' });
    await service.setActiveVehicle(identity, 'veh-2');

    // 4) Próxima resolución: cache-miss → re-lee fleet y ve el vehículo NUEVO (no el MOTO cacheado).
    const after = await resolver.resolve(identity, 'CAR');
    expect(after.vehicleType).toBe('CAR');
    expect(after.vehicleId).toBe('veh-2');
    // Se re-leyó fleet por la invalidación (segunda llamada real al firehose de fleet).
    expect(fleetGet).toHaveBeenCalledTimes(2);
  });

  it('si el PATCH a fleet FALLA, NO invalida la cache (el swap fallido no descarta el vehículo vigente)', async () => {
    const { service, resolver, fleetGet } = makeService({ patchRejects: true });

    // Cache poblada con el vehículo vigente.
    fleetGet.mockResolvedValueOnce({ id: 'veh-1', vehicleType: 'MOTO' });
    await resolver.resolve(identity, 'CAR');
    const invalidateSpy = vi.spyOn(resolver, 'invalidate');

    await expect(service.setActiveVehicle(identity, 'veh-2')).rejects.toThrow('fleet down');

    // El swap falló → no se invalidó nada; la cache sigue sirviendo el vehículo vigente sin re-leer fleet.
    expect(invalidateSpy).not.toHaveBeenCalled();
    const stillCached = await resolver.resolve(identity, 'CAR');
    expect(stillCached.vehicleType).toBe('MOTO');
    expect(fleetGet).toHaveBeenCalledTimes(1);
  });
});
