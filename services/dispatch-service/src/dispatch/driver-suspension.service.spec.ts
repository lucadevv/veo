/**
 * DriverSuspensionService — la EXCLUSIÓN del pool sigue a la suspensión autoritativa del conductor.
 * Lo crítico es el camino HOLDS-AWARE: una reactivación cierra UNA causa, pero si sobrevive otro hold
 * (suspendedAt!=null) el conductor PERMANECE excluido. Y el fail-safe: identity caído ⇒ relanza
 * (kafkajs reintenta), sin reincorporar a ciegas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DriverSuspensionService } from './driver-suspension.service';
import { InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import type { IdentityClient, IdentityDriver } from '../identity/identity-client.port';

const DRIVER = 'driver-1';

function identityFake(driver: Partial<IdentityDriver> & { found?: boolean }): IdentityClient {
  const full: IdentityDriver = {
    id: DRIVER,
    userId: 'user-1',
    currentStatus: 'AVAILABLE',
    suspendedAt: null,
    found: true,
    ...driver,
  };
  // getDriverByUser resuelve al MISMO driver (el fake no distingue id de perfil vs User.id: el contrato
  // que importa es que devuelve el perfil con su suspendedAt/found).
  return { getDriver: async () => full, getDriverByUser: async () => full };
}

describe('DriverSuspensionService', () => {
  let registry: InMemoryExclusionRegistry;
  beforeEach(() => {
    registry = new InMemoryExclusionRegistry();
  });

  it('onSuspended → excluye al conductor del pool de matching', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({}));
    await svc.onSuspended(DRIVER);
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });

  it('onSuspended es idempotente (re-entrega Kafka del mismo evento = no-op)', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({}));
    await svc.onSuspended(DRIVER);
    await svc.onSuspended(DRIVER);
    expect(await registry.filter([DRIVER])).toEqual([]); // sigue excluido, sin duplicar
  });

  it('onReactivated con suspendedAt=null (sin holds) → reincorpora al pool', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({ suspendedAt: null }));
    await registry.exclude(DRIVER);
    await svc.onReactivated(DRIVER);
    expect(await registry.isExcluded(DRIVER)).toBe(false);
  });

  it('[HOLDS-AWARE] onReactivated pero sigue suspendido por OTRO hold (suspendedAt!=null) → PERMANECE excluido', async () => {
    // Multi-causa: se levantó la disciplinaria pero queda la doc/ITV ⇒ suspendedAt sigue no-null.
    const svc = new DriverSuspensionService(
      registry,
      identityFake({ suspendedAt: new Date().toISOString() }),
    );
    await registry.exclude(DRIVER);
    await svc.onReactivated(DRIVER);
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });

  it('onReactivated con found=false (conductor borrado) → limpia (no excluir un fantasma)', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({ found: false }));
    await registry.exclude(DRIVER);
    await svc.onReactivated(DRIVER);
    expect(await registry.isExcluded(DRIVER)).toBe(false);
  });

  it('onReactivated con identity caído → RELANZA (kafkajs reintenta) y NO reincorpora a ciegas', async () => {
    const failing: IdentityClient = {
      getDriver: async () => {
        throw new Error('UNAVAILABLE');
      },
      getDriverByUser: async () => {
        throw new Error('UNAVAILABLE');
      },
    };
    const svc = new DriverSuspensionService(registry, failing);
    await registry.exclude(DRIVER);
    await expect(svc.onReactivated(DRIVER)).rejects.toThrow('UNAVAILABLE');
    // Permanece excluido: el reintento lo re-procesará cuando identity vuelva (el accept fail-closed es el backstop).
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });
});

describe('DriverSuspensionService · eje FLEET (doc/ITV) con clave dual', () => {
  let registry: InMemoryExclusionRegistry;
  beforeEach(() => {
    registry = new InMemoryExclusionRegistry();
  });

  it('[vía DOCUMENTO] onFleetSuspended con driverId de perfil → excluye directo (sin resolver)', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({}));
    await svc.onFleetSuspended({ driverId: DRIVER });
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });

  it('[vía ITV] onFleetSuspended con userId → resuelve User.id→Driver.id y excluye el PERFIL', async () => {
    // El fake resuelve getDriverByUser → full.id = DRIVER (el id de perfil). La exclusión cae en Driver.id,
    // NO en el User.id crudo (el landmine de key-space que el gate marcó).
    const svc = new DriverSuspensionService(registry, identityFake({ id: DRIVER, found: true }));
    await svc.onFleetSuspended({ userId: 'user-1' });
    expect(await registry.isExcluded(DRIVER)).toBe(true);
    expect(await registry.isExcluded('user-1')).toBe(false); // NO se excluyó la key cruda
  });

  it('[vía ITV] onFleetSuspended con userId de un conductor inexistente (found=false) → no-op', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({ found: false }));
    await svc.onFleetSuspended({ userId: 'fantasma' });
    expect(await registry.filter([DRIVER, 'fantasma'])).toEqual([DRIVER, 'fantasma']); // nada excluido
  });

  it('[vía ITV] onFleetReactivated con userId, suspendedAt=null → resuelve y reincorpora', async () => {
    const svc = new DriverSuspensionService(registry, identityFake({ suspendedAt: null }));
    await registry.exclude(DRIVER);
    await svc.onFleetReactivated({ userId: 'user-1' });
    expect(await registry.isExcluded(DRIVER)).toBe(false);
  });

  it('[HOLDS-AWARE] onFleetReactivated pero sobrevive OTRO hold (suspendedAt!=null) → PERMANECE excluido', async () => {
    const svc = new DriverSuspensionService(
      registry,
      identityFake({ suspendedAt: new Date().toISOString() }),
    );
    await registry.exclude(DRIVER);
    await svc.onFleetReactivated({ driverId: DRIVER });
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });
});
