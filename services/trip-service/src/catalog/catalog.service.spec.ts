import { describe, expect, it } from 'vitest';
import { OFFERING_LIST, OfferingId, PricingMode } from '@veo/shared-types';
import { CatalogService } from './catalog.service';
import type { CatalogTx, OfferingCatalogRepository, PersistedOverlay } from './catalog.repository';

/**
 * Repo fake en memoria (clean arch: el servicio depende del puerto). Captura el outbox emitido en la tx
 * para verificar que el PUT emite catalog.updated en la MISMA transacción que el upsert.
 */
class FakeRepo implements OfferingCatalogRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(private overlay: PersistedOverlay | null = null) {}

  find(): Promise<PersistedOverlay | null> {
    return Promise.resolve(this.overlay);
  }

  async runInTx<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    const tx: CatalogTx = {
      offeringCatalog: {
        // CAS: "actualiza" solo si la fila existe y su versión coincide con el WHERE (espejo del UPDATE ... WHERE version=).
        updateMany: (args) => {
          if (this.overlay?.version === args.where.version) {
            this.overlay = {
              overrides: (args.data.overrides as PersistedOverlay['overrides']) ?? [],
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.overlay = {
            overrides: (args.data.overrides as PersistedOverlay['overrides']) ?? [],
            version: args.data.version as number,
            updatedAt: new Date(0).toISOString(),
          };
          return Promise.resolve({ version: this.overlay.version, updatedAt: new Date(0) });
        },
        findUnique: () =>
          Promise.resolve(
            this.overlay ? { version: this.overlay.version, updatedAt: new Date(0) } : null,
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

describe('CatalogService', () => {
  it('sin fila (DB vacía) → catálogo efectivo en su defaultEnabled (RIDE on, verticales off · B5-4), version 0', async () => {
    const service = new CatalogService(new FakeRepo(null), 0);
    const view = await service.getCatalog();
    expect(view.version).toBe(0);
    // El catálogo completo viaja (admin puede verlas/habilitarlas); cada una en su defaultEnabled.
    expect(view.offerings).toHaveLength(OFFERING_LIST.length);
    const byId = new Map(view.offerings.map((o) => [o.id, o.enabled]));
    expect(byId.get(OfferingId.VEO_ECONOMICO)).toBe(true);
    expect(byId.get(OfferingId.VEO_AMBULANCE)).toBe(false);
    // Las visibles por default están todas habilitadas; las verticales, todas ocultas.
    expect(view.offerings.filter((o) => o.enabled).map((o) => o.id)).toEqual(
      OFFERING_LIST.filter((o) => o.defaultEnabled).map((o) => o.id),
    );
  });

  it('resolveActive excluye las deshabilitadas del overlay', async () => {
    const repo = new FakeRepo({
      overrides: [{ id: OfferingId.VEO_MOTO, enabled: false }],
      version: 3,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new CatalogService(repo, 0);
    const active = await service.resolveActive();
    expect(active.map((o) => o.id)).not.toContain(OfferingId.VEO_MOTO);
    expect(await service.isEnabled(OfferingId.VEO_MOTO)).toBe(false);
    expect(await service.isEnabled(OfferingId.VEO_ECONOMICO)).toBe(true);
  });

  it('replaceOverlay (expectedVersion correcta) bumpea version y emite catalog.updated en la misma tx', async () => {
    const repo = new FakeRepo({ overrides: [], version: 4, updatedAt: new Date(0).toISOString() });
    const service = new CatalogService(repo, 0);
    const view = await service.replaceOverlay([{ id: OfferingId.VEO_XL, enabled: false }], 4);
    expect(view.version).toBe(5); // 4 + 1
    expect(repo.outboxEvents).toEqual([{ aggregateId: 'GLOBAL', eventType: 'catalog.updated' }]);
    expect(view.offerings.find((o) => o.id === OfferingId.VEO_XL)?.enabled).toBe(false);
  });

  it('primera escritura (sin fila previa, expectedVersion 0) arranca en version 1', async () => {
    const repo = new FakeRepo(null);
    const service = new CatalogService(repo, 0);
    const view = await service.replaceOverlay([{ id: OfferingId.VEO_MOTO, enabled: true }], 0);
    expect(view.version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin cambió el catálogo; sin lost update)', async () => {
    const repo = new FakeRepo({ overrides: [], version: 7, updatedAt: new Date(0).toISOString() });
    const service = new CatalogService(repo, 0);
    await expect(
      service.replaceOverlay([{ id: OfferingId.VEO_XL, enabled: false }], 6),
    ).rejects.toThrow(/cambió/);
    expect(repo.outboxEvents).toEqual([]);
    expect((await service.getCatalog()).version).toBe(7); // intacto
  });

  it('B2 · replaceOverlay persiste mode/multiplier/minFareCents y resolveOffering los refleja', async () => {
    const repo = new FakeRepo(null);
    const service = new CatalogService(repo, 0);
    await service.replaceOverlay(
      [
        {
          id: OfferingId.VEO_ECONOMICO,
          enabled: true,
          mode: PricingMode.FIXED,
          multiplier: 1.5,
          minFareCents: 700,
        },
      ],
      0,
    );
    const eco = await service.resolveOffering(OfferingId.VEO_ECONOMICO);
    expect(eco?.mode).toBe(PricingMode.FIXED);
    expect(eco?.pricing.multiplier).toBe(1.5);
    expect(eco?.pricing.minFareCents).toBe(700);
  });

  it('ADR 023 §3 · replaceOverlay persiste los params por-servicio (base/km/min, incl. 0) y resolveOffering los refleja', async () => {
    const repo = new FakeRepo(null);
    const service = new CatalogService(repo, 0);
    await service.replaceOverlay(
      [
        {
          id: OfferingId.VEO_MECHANIC,
          enabled: true,
          baseFareCents: 2500,
          // 0 = no cobra distancia/tiempo (call-out plano). `0` es un valor VÁLIDO: NO debe perderse por un
          // guard truthy (normalize usa `!== undefined`, parse usa `>= 0`).
          perKmCents: 0,
          perMinCents: 0,
        },
      ],
      0,
    );
    const mech = await service.resolveOffering(OfferingId.VEO_MECHANIC);
    expect(mech?.pricing.baseFareCents).toBe(2500);
    expect(mech?.pricing.perKmCents).toBe(0);
    expect(mech?.pricing.perMinCents).toBe(0);
  });

  it('B2 · resolveOffering de un id inexistente → undefined', async () => {
    const service = new CatalogService(new FakeRepo(null), 0);
    expect(await service.resolveOffering('veo_fantasma')).toBeUndefined();
  });
});
