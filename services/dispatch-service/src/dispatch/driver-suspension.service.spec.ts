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
  return { getDriver: async () => full };
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
    };
    const svc = new DriverSuspensionService(registry, failing);
    await registry.exclude(DRIVER);
    await expect(svc.onReactivated(DRIVER)).rejects.toThrow('UNAVAILABLE');
    // Permanece excluido: el reintento lo re-procesará cuando identity vuelva (el accept fail-closed es el backstop).
    expect(await registry.isExcluded(DRIVER)).toBe(true);
  });
});
