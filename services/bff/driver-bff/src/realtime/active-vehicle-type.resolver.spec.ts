/**
 * Test de ActiveVehicleTypeResolver (driver-bff) — TOCTOU read-then-invalidate, ADR-017 §5(d) landmine d.2.
 *
 * El resolver cachea {value, expiresAt} por userId con TTL corto para no resolver fleet en cada ping
 * (por-segundo). El GET a fleet es un PUNTO DE YIELD: un `resolve` puede disparar el GET con el vehículo
 * VIEJO y volver DESPUÉS de que un swap concurrente invalidó la cache, re-escribiéndola con lo viejo
 * (re-envenenamiento por ~TTL). El fix es una invalidación EPOCH-AWARE: `invalidate` incrementa una
 * generación por key, y `resolve` solo cachea si la generación NO cambió mientras su GET estaba en vuelo.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { ActiveVehicleTypeResolver } from './active-vehicle-type.resolver';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

/** Promesa diferida controlable: exponemos `resolve` para soltar la respuesta del GET cuando queramos. */
function deferred<T>() {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

function makeResolver() {
  const fleetGet = vi.fn();
  const rest = { client: vi.fn(() => ({ get: fleetGet })) };
  const resolver = new ActiveVehicleTypeResolver(rest as never);
  return { resolver, fleetGet };
}

describe('ActiveVehicleTypeResolver — invalidación epoch-aware (anti-TOCTOU, ADR-017 d.2)', () => {
  it('un invalidate() durante un resolve() EN VUELO NO deja que la respuesta vieja re-envenene la cache', async () => {
    const { resolver, fleetGet } = makeResolver();

    // T0: arranca un resolve() cache-miss. fleet devuelve veh-1 (el swap aún no commiteó) PERO en vuelo:
    // devolvemos una promesa diferida que NO resolvemos todavía → el resolve queda esperando el yield.
    const inflight = deferred<{ id: string; vehicleType: 'MOTO' }>();
    fleetGet.mockReturnValueOnce(inflight.promise);
    const resolvePromise = resolver.resolve(identity, 'CAR');

    // T1: mientras el GET de T0 sigue en vuelo, el conductor hace SWAP → setActiveVehicle invalida la cache.
    resolver.invalidate(identity.userId);

    // T2: recién ahora llega la respuesta del GET de T0 (vehículo VIEJO veh-1) y corre la continuación del
    // resolve (el `cache.set` post-await). Con el fix, el guard epoch impide cachear este valor stale.
    inflight.resolve({ id: 'veh-1', vehicleType: 'MOTO' });
    const inflightResult = await resolvePromise;

    // Este caller recibe el valor que resolvió (lo mejor que hay para ESTE ping puntual)…
    expect(inflightResult.vehicleType).toBe('MOTO');
    expect(inflightResult.vehicleId).toBe('veh-1');

    // …PERO la cache NO quedó envenenada con veh-1: el próximo resolve hace cache-miss y re-lee fleet, que
    // ahora devuelve el vehículo NUEVO post-swap (veh-2). Sin el fix, este resolve pegaría HIT a veh-1 y
    // fleetGet NO se llamaría una 2da vez → el assert de abajo (toHaveBeenCalledTimes(2)) fallaría.
    fleetGet.mockResolvedValueOnce({ id: 'veh-2', vehicleType: 'CAR' });
    const after = await resolver.resolve(identity, 'CAR');
    expect(after.vehicleType).toBe('CAR');
    expect(after.vehicleId).toBe('veh-2');
    expect(fleetGet).toHaveBeenCalledTimes(2);
  });

  it('sin invalidate concurrente, un resolve() SÍ cachea (la próxima resolución viene de cache, no re-lee fleet)', async () => {
    const { resolver, fleetGet } = makeResolver();

    fleetGet.mockResolvedValueOnce({ id: 'veh-1', vehicleType: 'MOTO' });
    const first = await resolver.resolve(identity, 'CAR');
    expect(first.vehicleType).toBe('MOTO');

    // Segunda resolución sin swap: HIT de cache, fleet NO se vuelve a llamar.
    const second = await resolver.resolve(identity, 'CAR');
    expect(second.vehicleType).toBe('MOTO');
    expect(second.vehicleId).toBe('veh-1');
    expect(fleetGet).toHaveBeenCalledTimes(1);
  });
});
