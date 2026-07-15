import { describe, expect, it } from 'vitest';
import {
  OFFERING_LIST,
  OfferingId,
  PricingMode,
  ServiceType,
  VehicleClass,
  type CustomOfferingRecord,
} from '@veo/shared-types';
import { CatalogService } from './catalog.service';
import type { CatalogTx, OfferingCatalogRepository, PersistedOverlay } from './catalog.repository';
import type {
  CustomOfferingRepository,
  CustomOfferingTx,
} from './custom-offering.repository';

/**
 * Repo fake en memoria de la tabla `CustomOffering` (clean arch). `forceCollisions` simula que el id generado
 * ya existe N veces (para probar el reintento de unicidad). Captura el outbox emitido en el ALTA.
 */
class FakeCustomRepo implements CustomOfferingRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  created: Record<string, unknown>[] = [];
  existsCalls = 0;

  constructor(
    private rows: CustomOfferingRecord[] = [],
    private forceCollisions = 0,
  ) {}

  findAll(): Promise<CustomOfferingRecord[]> {
    return Promise.resolve(this.rows);
  }

  existsById(id: string): Promise<boolean> {
    this.existsCalls++;
    if (this.forceCollisions > 0) {
      this.forceCollisions--;
      return Promise.resolve(true); // finge que el id está tomado → el service reintenta
    }
    return Promise.resolve(this.rows.some((r) => r.id === id));
  }

  async runInTx<T>(fn: (tx: CustomOfferingTx) => Promise<T>): Promise<T> {
    const tx: CustomOfferingTx = {
      customOffering: {
        create: (args) => {
          this.created.push(args.data);
          const d = args.data as {
            id: string;
            name: string;
            vehicleClass: VehicleClass;
            serviceType: ServiceType;
            mode: PricingMode;
            multiplier: number;
            minFareCents: number;
            enabled: boolean;
          };
          this.rows.push({
            id: d.id,
            name: d.name,
            vehicleClass: d.vehicleClass,
            serviceType: d.serviceType,
            mode: d.mode,
            multiplier: d.multiplier,
            minFareCents: d.minFareCents,
            enabled: d.enabled,
          });
          return Promise.resolve({ id: d.id, createdAt: new Date(0) });
        },
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

describe('CatalogService · ofertas CUSTOM (ADR 013)', () => {
  const sampleCustom: CustomOfferingRecord = {
    id: 'custom_abc123',
    name: 'VEO Playa',
    vehicleClass: VehicleClass.CAR,
    serviceType: ServiceType.RIDE,
    mode: PricingMode.FIXED,
    multiplier: 1.3,
    minFareCents: 600,
    enabled: true,
  };

  it('getCatalog UNE built-in ∪ custom: la custom aparece con name/pricing/mode/isCustom', async () => {
    const service = new CatalogService(new FakeRepo(null), 0, new FakeCustomRepo([sampleCustom]));
    const view = await service.getCatalog();
    // built-in + 1 custom
    expect(view.offerings).toHaveLength(OFFERING_LIST.length + 1);
    const c = view.offerings.find((o) => o.id === 'custom_abc123');
    expect(c?.name).toBe('VEO Playa');
    expect(c?.isCustom).toBe(true);
    expect(c?.pricing.multiplier).toBe(1.3);
    expect(c?.pricing.minFareCents).toBe(600);
    expect(c?.mode).toBe(PricingMode.FIXED);
    expect(c?.vehicleClass).toBe(VehicleClass.CAR);
    expect(c?.modeLocked).toBe(false);
    // Las custom ordenan DESPUÉS de las built-in (sortOrder alto).
    expect(view.offerings[view.offerings.length - 1]?.id).toBe('custom_abc123');
  });

  it('createCustomOffering genera id custom_*, trimea el name, persiste y emite catalog.updated', async () => {
    const customRepo = new FakeCustomRepo([]);
    const service = new CatalogService(new FakeRepo(null), 0, customRepo);
    const created = await service.createCustomOffering({
      name: '  VEO Playa  ',
      vehicleClass: VehicleClass.CAR,
      serviceType: ServiceType.RIDE,
      mode: PricingMode.PUJA,
      multiplier: 1.2,
      minFareCents: 500,
      enabled: true,
      createdBy: 'admin-1',
    });
    expect(created.id).toMatch(/^custom_[0-9a-f]+$/);
    expect(created.name).toBe('VEO Playa'); // trim
    expect(created.isCustom).toBe(true);
    expect(created.mode).toBe(PricingMode.PUJA);
    expect(customRepo.created).toHaveLength(1);
    expect(customRepo.created[0]).toMatchObject({ name: 'VEO Playa', createdBy: 'admin-1' });
    // Outbox catalog.updated en la MISMA tx (mismo patrón que el PUT del overlay).
    expect(customRepo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'catalog.updated' },
    ]);
    // Y aparece en el catálogo efectivo (cache invalidado por el alta).
    const view = await service.getCatalog();
    expect(view.offerings.some((o) => o.id === created.id)).toBe(true);
  });

  it('createCustomOffering RECHAZA vehicleClass/serviceType/mode/multiplier/minFare/name inválidos', async () => {
    const service = new CatalogService(new FakeRepo(null), 0, new FakeCustomRepo([]));
    const base = {
      name: 'VEO Playa',
      vehicleClass: VehicleClass.CAR,
      serviceType: ServiceType.RIDE,
      mode: PricingMode.FIXED,
      multiplier: 1,
      minFareCents: 500,
      enabled: true,
    };
    await expect(
      service.createCustomOffering({ ...base, vehicleClass: 'PLANE' as VehicleClass }),
    ).rejects.toThrow(/vehicleClass/);
    await expect(
      service.createCustomOffering({ ...base, serviceType: 'BOAT' as ServiceType }),
    ).rejects.toThrow(/serviceType/);
    await expect(
      service.createCustomOffering({ ...base, mode: 'BARTER' as PricingMode }),
    ).rejects.toThrow(/mode/);
    await expect(service.createCustomOffering({ ...base, multiplier: 0 })).rejects.toThrow(
      /multiplier/,
    );
    await expect(service.createCustomOffering({ ...base, minFareCents: -1 })).rejects.toThrow(
      /minFareCents/,
    );
    await expect(service.createCustomOffering({ ...base, name: '   ' })).rejects.toThrow(/name/);
  });

  it('unicidad: si el id generado ya está tomado, REINTENTA hasta uno libre', async () => {
    const customRepo = new FakeCustomRepo([], 2); // las 2 primeras consultas fingen colisión
    const service = new CatalogService(new FakeRepo(null), 0, customRepo);
    const created = await service.createCustomOffering({
      name: 'VEO Playa',
      vehicleClass: VehicleClass.CAR,
      serviceType: ServiceType.RIDE,
      mode: PricingMode.FIXED,
      multiplier: 1,
      minFareCents: 500,
      enabled: true,
    });
    expect(created.id).toMatch(/^custom_/);
    expect(customRepo.existsCalls).toBe(3); // 2 colisiones + 1 libre
    expect(customRepo.created).toHaveLength(1);
  });

  it('el overlay del admin APLICA a una custom (deshabilitar + pisar pricing/modo)', async () => {
    const overlay: PersistedOverlay = {
      overrides: [{ id: 'custom_abc123', enabled: false, multiplier: 2, mode: PricingMode.PUJA }],
      version: 1,
      updatedAt: new Date(0).toISOString(),
    };
    const service = new CatalogService(
      new FakeRepo(overlay),
      0,
      new FakeCustomRepo([sampleCustom]),
    );
    const resolved = await service.resolveOffering('custom_abc123');
    expect(resolved?.enabled).toBe(false);
    expect(resolved?.pricing.multiplier).toBe(2); // override pisa la base de la tabla (1.3)
    expect(resolved?.mode).toBe(PricingMode.PUJA); // pin del admin (una custom nunca está locked)
    // Deshabilitada por overlay → excluida de las activas.
    const active = await service.resolveActive();
    expect(active.some((o) => o.id === 'custom_abc123')).toBe(false);
    // isEnabled refleja el overlay.
    expect(await service.isEnabled('custom_abc123')).toBe(false);
  });
});
