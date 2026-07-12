/**
 * CarpoolSearchConfigService (F2 · radio de búsqueda editable por el admin, singleton GLOBAL). Repo fake en
 * memoria (clean arch: el servicio depende del puerto). Cubre: la DEGRADACIÓN HONESTA al env (sin fila), el
 * mapeo km→k (getKRings/getResolvedRadii), el PUT (bump version + outbox en la misma tx + invalida cache), y
 * las cotas del radio (rangos + expand ≥ base). Espeja el spec de cost-per-km-config.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@veo/utils';
import { CarpoolSearchConfigService } from './carpool-search-config.service';
import type {
  CarpoolSearchConfigRepository,
  SearchConfigTx,
  PersistedSearchConfig,
} from './carpool-search-config.repository';
import { SEARCH_RADIUS_CONFIG_UPDATED } from './carpool-search-config.service';
import type { SearchRadii } from './carpool-search-config.service';

/** Defaults del env de prueba: base=0.3km (k1) / expand=0.6km (k2). Solo se usa si no hay fila persistida. */
const ENV_DEFAULTS: SearchRadii = { baseRadiusKm: 0.3, expandRadiusKm: 0.6 };

interface CapturedOutbox {
  aggregateId: string;
  eventType: string;
  envelope: unknown;
}

class FakeRepo implements CarpoolSearchConfigRepository {
  /** El singleton (o null si no hay fila). */
  private row: PersistedSearchConfig | null;
  /** Eventos encolados por el PUT (para verificar el outbox-en-transacción). */
  readonly outbox: CapturedOutbox[] = [];

  constructor(
    initial: PersistedSearchConfig | null = null,
    private failFind = false,
  ) {
    this.row = initial;
  }

  find(): Promise<PersistedSearchConfig | null> {
    if (this.failFind) return Promise.reject(new Error('DB down'));
    return Promise.resolve(this.row);
  }

  async runInTx<T>(fn: (tx: SearchConfigTx) => Promise<T>): Promise<T> {
    const tx: SearchConfigTx = {
      carpoolSearchConfig: {
        upsert: (args) => {
          const data = (this.row ? args.update : args.create) as {
            baseRadiusKm: number;
            expandRadiusKm: number;
            version: number;
          };
          this.row = {
            baseRadiusKm: data.baseRadiusKm,
            expandRadiusKm: data.expandRadiusKm,
            version: data.version,
            updatedAt: new Date(0).toISOString(),
          };
          return Promise.resolve({ version: data.version, updatedAt: new Date(0) });
        },
      },
      outboxEvent: {
        create: (args) => {
          this.outbox.push(args.data);
          return Promise.resolve(undefined);
        },
      },
    };
    return fn(tx);
  }
}

const row = (over: Partial<PersistedSearchConfig> = {}): PersistedSearchConfig => ({
  baseRadiusKm: 0.3,
  expandRadiusKm: 0.6,
  version: 1,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

describe('CarpoolSearchConfigService (F2 · radio editable, singleton GLOBAL)', () => {
  it('sin fila (DB sin migrar) → degrada al env: base 0.3 / expand 0.6, version 0', async () => {
    const service = new CarpoolSearchConfigService(new FakeRepo(), 0, ENV_DEFAULTS);
    expect(await service.getConfig()).toEqual({
      baseRadiusKm: 0.3,
      expandRadiusKm: 0.6,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → devuelve el valor persistido del admin (no el env)', async () => {
    const service = new CarpoolSearchConfigService(
      new FakeRepo(row({ baseRadiusKm: 0.9, expandRadiusKm: 1.5, version: 4 })),
      0,
      ENV_DEFAULTS,
    );
    const cfg = await service.getConfig();
    expect(cfg.baseRadiusKm).toBe(0.9);
    expect(cfg.expandRadiusKm).toBe(1.5);
    expect(cfg.version).toBe(4);
  });

  it('getKRings mapea km→k (ceil, ~0.3km/anillo): 0.3→k1, 0.6→k2', async () => {
    const service = new CarpoolSearchConfigService(new FakeRepo(), 0, ENV_DEFAULTS);
    expect(await service.getKRings()).toEqual({ kRing: 1, kRingExpand: 2 });
  });

  it('getKRings: un radio a mitad de anillo redondea HACIA ARRIBA (0.31km → k2, 0km → k0)', async () => {
    const service = new CarpoolSearchConfigService(
      new FakeRepo(row({ baseRadiusKm: 0, expandRadiusKm: 0.31 })),
      0,
      ENV_DEFAULTS,
    );
    expect(await service.getKRings()).toEqual({ kRing: 0, kRingExpand: 2 });
  });

  it('getResolvedRadii devuelve radios km + k derivados (para el radar preview)', async () => {
    const service = new CarpoolSearchConfigService(
      new FakeRepo(row({ baseRadiusKm: 0.6, expandRadiusKm: 1.2 })),
      0,
      ENV_DEFAULTS,
    );
    expect(await service.getResolvedRadii()).toEqual({
      baseRadiusKm: 0.6,
      expandRadiusKm: 1.2,
      baseKRing: 2,
      expandKRing: 4,
    });
  });

  it('DEGRADACIÓN HONESTA · getConfig con repo caído propaga (getConfig no cachea), pero getKRings sin fila no rompe', async () => {
    // getConfig lee directo del repo; si el repo cae, propaga (el controller lo mapea). El hot-path (getKRings)
    // usa el snapshot: sin fila degrada al env. Verificamos el segundo (el crítico para la búsqueda).
    const service = new CarpoolSearchConfigService(new FakeRepo(null), 0, ENV_DEFAULTS);
    expect(await service.getKRings()).toEqual({ kRing: 1, kRingExpand: 2 });
  });

  it('replaceConfig persiste, bumpea version (0→1), emite el outbox y autoaplica (cache invalidado)', async () => {
    const repo = new FakeRepo(); // sin fila
    const service = new CarpoolSearchConfigService(repo, 10_000, ENV_DEFAULTS);

    const out = await service.replaceConfig({ baseRadiusKm: 0.9, expandRadiusKm: 1.2 });

    expect(out).toMatchObject({ baseRadiusKm: 0.9, expandRadiusKm: 1.2, version: 1 });
    // Outbox EN LA MISMA TX: un evento del cambio de config.
    expect(repo.outbox).toHaveLength(1);
    expect(repo.outbox[0]!.eventType).toBe(SEARCH_RADIUS_CONFIG_UPDATED);
    expect(repo.outbox[0]!.aggregateId).toBe('GLOBAL');
    // Autoaplica: el cambio se ve de inmediato (cache invalidado) → 0.9km=k3, 1.2km=k4.
    expect(await service.getKRings()).toEqual({ kRing: 3, kRingExpand: 4 });
  });

  it('replaceConfig sobre una fila existente bumpea desde su version (4→5)', async () => {
    const repo = new FakeRepo(row({ version: 4 }));
    const service = new CarpoolSearchConfigService(repo, 0, ENV_DEFAULTS);
    const out = await service.replaceConfig({ baseRadiusKm: 0.6, expandRadiusKm: 0.9 });
    expect(out.version).toBe(5);
  });

  it('emite el evento booking.search_radius_config_updated', () => {
    expect(SEARCH_RADIUS_CONFIG_UPDATED).toBe('booking.search_radius_config_updated');
  });

  it('rechaza radios fuera de rango (base > 1.5 / expand > 2.4)', async () => {
    const service = new CarpoolSearchConfigService(new FakeRepo(), 0, ENV_DEFAULTS);
    await expect(service.replaceConfig({ baseRadiusKm: 2.0, expandRadiusKm: 2.4 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.replaceConfig({ baseRadiusKm: 0.3, expandRadiusKm: 3.0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rechaza expand < base (radio expandido invertido)', async () => {
    const service = new CarpoolSearchConfigService(new FakeRepo(), 0, ENV_DEFAULTS);
    await expect(service.replaceConfig({ baseRadiusKm: 1.2, expandRadiusKm: 0.6 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rechaza expand por debajo de su piso (0.3km)', async () => {
    const service = new CarpoolSearchConfigService(new FakeRepo(), 0, ENV_DEFAULTS);
    await expect(service.replaceConfig({ baseRadiusKm: 0.0, expandRadiusKm: 0.1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
