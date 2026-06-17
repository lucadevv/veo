/**
 * EnergyCatalogService (B5) — catálogo de precios de energía por fuente. Repo fake en memoria (clean arch:
 * el servicio depende del puerto), captura el outbox de la tx. CAS idéntico a fuel/catalog.
 */
import { describe, expect, it } from 'vitest';
import { EnergySource, EnergyUnit, type EnergySourcePrice } from '@veo/shared-types';
import { EnergyCatalogService } from './energy-catalog.service';
import type {
  EnergyCatalogRepository,
  EnergyCatalogTx,
  PersistedEnergyCatalog,
} from './energy-catalog.repository';

class FakeRepo implements EnergyCatalogRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(private config: PersistedEnergyCatalog | null = null) {}

  find(): Promise<PersistedEnergyCatalog | null> {
    return Promise.resolve(this.config);
  }

  async runInTx<T>(fn: (tx: EnergyCatalogTx) => Promise<T>): Promise<T> {
    const tx: EnergyCatalogTx = {
      energyCatalog: {
        // CAS: "actualiza" solo si la fila existe y su versión coincide con el WHERE.
        updateMany: (args) => {
          if (this.config?.version === args.where.version) {
            this.config = {
              sources: args.data.sources as EnergySourcePrice[],
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            sources: args.data.sources as EnergySourcePrice[],
            version: args.data.version as number,
            updatedAt: new Date(0).toISOString(),
          };
          return Promise.resolve({ version: this.config.version, updatedAt: new Date(0) });
        },
        findUnique: () =>
          Promise.resolve(
            this.config ? { version: this.config.version, updatedAt: new Date(0) } : null,
          ),
      },
      outboxEvent: {
        create: (args) => {
          this.outboxEvents.push({
            aggregateId: args.data.aggregateId,
            eventType: args.data.eventType,
          });
          return Promise.resolve({});
        },
      },
    };
    return fn(tx);
  }
}

const GAS: EnergySourcePrice = {
  sourceId: EnergySource.GASOLINE_95,
  unit: EnergyUnit.LITER,
  pricePerUnitCents: 1640,
};
const ELEC: EnergySourcePrice = {
  sourceId: EnergySource.ELECTRIC,
  unit: EnergyUnit.KWH,
  pricePerUnitCents: 65,
};

describe('EnergyCatalogService (B5)', () => {
  it('sin fila (DB vacía) → getCatalog vacío y getPriceFor null (degradación honesta)', async () => {
    const service = new EnergyCatalogService(new FakeRepo(null), 0);
    expect(await service.getCatalog()).toMatchObject({ sources: [], version: 0 });
    expect(await service.getPriceFor(EnergySource.GASOLINE_95)).toBeNull();
  });

  it('con fila → getPriceFor devuelve el precio/unidad de la fuente (y null si no está)', async () => {
    const repo = new FakeRepo({ sources: [GAS], version: 3, updatedAt: new Date(0).toISOString() });
    const service = new EnergyCatalogService(repo, 0);
    expect(await service.getPriceFor(EnergySource.GASOLINE_95)).toBe(1640);
    expect(await service.getPriceFor(EnergySource.DIESEL)).toBeNull();
  });

  it('replace (expectedVersion correcta) bumpea version, emite energy.catalog_updated y re-deriva el precio', async () => {
    const repo = new FakeRepo({ sources: [GAS], version: 4, updatedAt: new Date(0).toISOString() });
    const service = new EnergyCatalogService(repo, 0);
    const out = await service.replace([GAS, ELEC], 4);
    expect(out.version).toBe(5);
    expect(out.sources).toHaveLength(2);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'energy.catalog_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado): la nueva fuente eléctrica ya resuelve.
    expect(await service.getPriceFor(EnergySource.ELECTRIC)).toBe(65);
  });

  it('primera escritura (sin fila previa, expectedVersion 0) arranca en version 1', async () => {
    const service = new EnergyCatalogService(new FakeRepo(null), 0);
    expect((await service.replace([GAS], 0)).version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin cambió el catálogo; sin lost update)', async () => {
    const repo = new FakeRepo({ sources: [GAS], version: 7, updatedAt: new Date(0).toISOString() });
    const service = new EnergyCatalogService(repo, 0);
    await expect(service.replace([ELEC], 6)).rejects.toThrow(/cambió/);
    expect(repo.outboxEvents).toEqual([]);
    expect((await service.getCatalog()).version).toBe(7); // intacto
  });
});
