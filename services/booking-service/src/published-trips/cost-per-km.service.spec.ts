import { describe, it, expect, vi } from 'vitest';
import { ValidationError } from '@veo/utils';
import type { InternalRestClient } from '@veo/rpc';
import { CostPerKmService } from './cost-per-km.service';
import { PAIS, type CostPerKmConfig } from '../domain/cost-cap';

/** env de fallback: PE=100, EC=50 (los defaults provisionales del schema). */
const CONFIG: CostPerKmConfig = { [PAIS.PE]: 100, [PAIS.EC]: 50 };

/** Reply del EnergyCatalog con un precio de GASOLINE_90 (céntimos/L). */
function catalogWith(gasoline90Cents: number) {
  return {
    sources: [
      { sourceId: 'GASOLINE_90', unit: 'LITER', pricePerUnitCents: gasoline90Cents },
      { sourceId: 'DIESEL', unit: 'LITER', pricePerUnitCents: 999 },
    ],
    version: 1,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Doble del InternalRestClient: solo `get` se usa; el resto lanzaría (no debería llamarse). */
function makeTripRest(getFn: () => Promise<unknown>): {
  tripRest: InternalRestClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(getFn);
  const tripRest = { get } as unknown as InternalRestClient;
  return { tripRest, get };
}

function makeService(
  getFn: () => Promise<unknown>,
  config: CostPerKmConfig = CONFIG,
  ttlMs = 10_000,
): { service: CostPerKmService; get: ReturnType<typeof vi.fn> } {
  const { tripRest, get } = makeTripRest(getFn);
  return { service: new CostPerKmService(tripRest, config, ttlMs), get };
}

describe('CostPerKmService · PE deriva del precio VIVO', () => {
  it('500 c/L ÷ 12 km/L (económico) → 42 (gana sobre el env 100)', async () => {
    const { service } = makeService(async () => catalogWith(500));
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(42);
  });

  it('lee GASOLINE_90 (no otra fuente): 600 ÷ 12 → 50', async () => {
    const { service, get } = makeService(async () => catalogWith(600));
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(50);
    expect(get).toHaveBeenCalledWith('/internal/pricing/energy-catalog', expect.anything());
  });
});

describe('CostPerKmService · DEGRADACIÓN HONESTA al env (nunca rompe el publish)', () => {
  it('trip-service caído (get rechaza) → env PE (100)', async () => {
    const { service } = makeService(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(100);
  });

  it('catálogo sin GASOLINE_90 → env PE (100)', async () => {
    const { service } = makeService(async () => ({
      sources: [{ sourceId: 'DIESEL', unit: 'LITER', pricePerUnitCents: 700 }],
      version: 1,
      updatedAt: new Date(0).toISOString(),
    }));
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(100);
  });

  it('precio 0 (derivación degenerada → 0) → env PE (100)', async () => {
    const { service } = makeService(async () => catalogWith(0));
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(100);
  });
});

describe('CostPerKmService · EC usa SIEMPRE el env (energía no es per-país hasta F8)', () => {
  it('EC → env EC (50), SIN tocar trip-service', async () => {
    const { service, get } = makeService(async () => catalogWith(500));
    await expect(service.getCostPerKmCents(PAIS.EC)).resolves.toBe(50);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('CostPerKmService · país no soportado → ValidationError tipado', () => {
  it('"BR" → ValidationError (no un fallback silencioso)', async () => {
    const { service } = makeService(async () => catalogWith(500));
    await expect(service.getCostPerKmCents('BR')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CostPerKmService · cache (un slot) + invalidación', () => {
  it('dentro del TTL: una sola lectura a trip-service (la 2da pega al cache)', async () => {
    const { service, get } = makeService(async () => catalogWith(500));
    await service.getCostPerKmCents(PAIS.PE);
    await service.getCostPerKmCents(PAIS.PE);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache() fuerza re-lectura (ve el precio nuevo)', async () => {
    let price = 500;
    const { service, get } = makeService(async () => catalogWith(price));
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(42); // 500/12

    price = 720; // el admin editó el EnergyCatalog (energy.catalog_updated)
    service.invalidateCache();
    await expect(service.getCostPerKmCents(PAIS.PE)).resolves.toBe(60); // 720/12
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('TTL=0 → no cachea (cada lectura re-pega)', async () => {
    const { service, get } = makeService(async () => catalogWith(500), CONFIG, 0);
    await service.getCostPerKmCents(PAIS.PE);
    await service.getCostPerKmCents(PAIS.PE);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
