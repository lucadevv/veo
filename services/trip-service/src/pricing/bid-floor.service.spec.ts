/**
 * BidFloorService (ADR 010 §9.3) — piso de la PUJA per-(zona, oferta), editable en caliente. Repo fake en
 * memoria (clean arch: el servicio depende del puerto), captura el outbox de la tx. Espeja
 * fuel-surcharge.service.spec; el caso CLAVE es la RESOLUCIÓN per-oferta (override > default).
 */
import { describe, expect, it } from 'vitest';
import { OfferingId, GLOBAL_ZONE } from '@veo/shared-types';
import { BidFloorService } from './bid-floor.service';
import { pricingConfigChangedTotal } from '../trips/trip-metrics';
import type { BidFloorRepository, BidFloorTx, PersistedBidFloor } from './bid-floor.repository';

async function readPricingChanged(kind: string): Promise<number> {
  const m = await pricingConfigChangedTotal.get();
  return m.values.filter((v) => v.labels.kind === kind).reduce((s, v) => s + v.value, 0);
}

class FakeRepo implements BidFloorRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(private config: PersistedBidFloor | null = null) {}

  find(): Promise<PersistedBidFloor | null> {
    return Promise.resolve(this.config);
  }

  async runInTx<T>(fn: (tx: BidFloorTx) => Promise<T>): Promise<T> {
    const tx: BidFloorTx = {
      bidFloorConfig: {
        // CAS: solo "actualiza" si la fila existe Y su versión coincide con el WHERE.
        updateMany: (args) => {
          if (this.config?.version === args.where.version) {
            this.config = {
              defaultFloorCents: args.data.defaultFloorCents as number,
              overrides: args.data.overrides as PersistedBidFloor['overrides'],
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            defaultFloorCents: args.data.defaultFloorCents as number,
            overrides: args.data.overrides as PersistedBidFloor['overrides'],
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

describe('BidFloorService (ADR 010 §9.3 · per-oferta, zone-ready)', () => {
  it('sin fila (DB vacía) → resolve devuelve el DEFAULT (S/7) para cualquier oferta (degradación honesta)', async () => {
    const service = new BidFloorService(new FakeRepo(null), 0);
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_MOTO)).toBe(700);
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_CONFORT)).toBe(700);
    const cfg = await service.getConfig();
    expect(cfg).toEqual({
      defaultFloorCents: 700,
      overrides: [],
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('CLAVE · resolve per-oferta: override de la oferta GANA; sin override cae al default', async () => {
    const repo = new FakeRepo({
      defaultFloorCents: 700,
      overrides: [
        { zone: 'GLOBAL', offeringId: OfferingId.VEO_MOTO, floorCents: 300 },
        { zone: 'GLOBAL', offeringId: OfferingId.VEO_CONFORT, floorCents: 900 },
      ],
      version: 2,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BidFloorService(repo, 0);
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_MOTO)).toBe(300); // override
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_CONFORT)).toBe(900); // override
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_XL)).toBe(700); // sin override → default
  });

  it('replace (expectedVersion correcta) bumpea version, emite el evento en la misma tx e invalida cache', async () => {
    const repo = new FakeRepo({
      defaultFloorCents: 700,
      overrides: [],
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BidFloorService(repo, 0);
    const out = await service.replace({
      defaultFloorCents: 700,
      overrides: [{ zone: 'GLOBAL', offeringId: OfferingId.VEO_MOTO, floorCents: 300 }],
      expectedVersion: 4,
    });
    expect(out.version).toBe(5);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'pricing.bid_floor_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado): la moto ahora resuelve a 300.
    expect(await service.resolve(GLOBAL_ZONE, OfferingId.VEO_MOTO)).toBe(300);
  });

  it('primera escritura (sin fila previa, expectedVersion 0) arranca en version 1', async () => {
    const service = new BidFloorService(new FakeRepo(null), 0);
    expect(
      (await service.replace({ defaultFloorCents: 700, overrides: [], expectedVersion: 0 }))
        .version,
    ).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin cambió el config; sin lost update)', async () => {
    const repo = new FakeRepo({
      defaultFloorCents: 700,
      overrides: [],
      version: 7,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BidFloorService(repo, 0);
    await expect(
      service.replace({ defaultFloorCents: 500, overrides: [], expectedVersion: 6 }),
    ).rejects.toThrow(/cambió/);
    expect(await service.getConfig()).toMatchObject({ defaultFloorCents: 700, version: 7 });
    expect(repo.outboxEvents).toEqual([]);
  });

  it('CAS · primer write pero la fila ya existe (expectedVersion 0 stale) → ConflictError', async () => {
    const repo = new FakeRepo({
      defaultFloorCents: 700,
      overrides: [],
      version: 3,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BidFloorService(repo, 0);
    await expect(
      service.replace({ defaultFloorCents: 500, overrides: [], expectedVersion: 0 }),
    ).rejects.toThrow(/inicializado/);
    expect(repo.outboxEvents).toEqual([]);
  });

  it('#3 observabilidad: un replace EXITOSO bumpea veo_pricing_config_changed_total{kind=bid_floor}; un conflicto NO', async () => {
    const before = await readPricingChanged('bid_floor');
    const repo = new FakeRepo({
      defaultFloorCents: 700,
      overrides: [],
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BidFloorService(repo, 0);
    await service.replace({ defaultFloorCents: 700, overrides: [], expectedVersion: 4 });
    expect(await readPricingChanged('bid_floor')).toBe(before + 1);
    await expect(
      service.replace({ defaultFloorCents: 700, overrides: [], expectedVersion: 4 }),
    ).rejects.toThrow(/cambió/);
    expect(await readPricingChanged('bid_floor')).toBe(before + 1);
  });
});
