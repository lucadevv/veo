/**
 * CostPerKmConfigService (F2.5) — costo de OPERACIÓN por km, editable en caliente por el admin, POR PAÍS.
 * Repo fake en memoria (clean arch: el servicio depende del puerto), keyed por país. Cubre: el valor DIRECTO
 * del admin (no derivado de energía), la DEGRADACIÓN HONESTA al env (sin fila / DB caída), el CAS per-país, y
 * que el seed PE=150 es editable.
 */
import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@veo/utils';
import { CostPerKmConfigService } from './cost-per-km-config.service';
import type {
  CostPerKmConfigRepository,
  CostPerKmTx,
  PersistedCostPerKm,
} from './cost-per-km-config.repository';
import { PAIS, type CostPerKmConfig } from '../domain/cost-cap';

/** Env de FALLBACK de prueba: PE=150 (seed), EC=50. Solo se usa cuando la config persistida no está. */
const ENV: CostPerKmConfig = { [PAIS.PE]: 150, [PAIS.EC]: 50 };

class FakeRepo implements CostPerKmConfigRepository {
  /** Store por país: lo que el GET lee y el PUT muta (CAS). */
  private store = new Map<string, PersistedCostPerKm>();

  constructor(
    rows: PersistedCostPerKm[] = [],
    private failFind = false,
  ) {
    for (const r of rows) this.store.set(r.pais, r);
  }

  find(pais: string): Promise<PersistedCostPerKm | null> {
    if (this.failFind) return Promise.reject(new Error('DB down'));
    return Promise.resolve(this.store.get(pais) ?? null);
  }

  async runInTx<T>(fn: (tx: CostPerKmTx) => Promise<T>): Promise<T> {
    const tx: CostPerKmTx = {
      costPerKmConfig: {
        updateMany: (args) => {
          const cur = this.store.get(args.where.pais);
          if (cur?.version === args.where.version) {
            this.store.set(args.where.pais, {
              pais: args.where.pais,
              costPerKmCents: args.data.costPerKmCents as number,
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            });
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          const pais = args.data.pais as string;
          const row: PersistedCostPerKm = {
            pais,
            costPerKmCents: args.data.costPerKmCents as number,
            version: args.data.version as number,
            updatedAt: new Date(0).toISOString(),
          };
          this.store.set(pais, row);
          return Promise.resolve({ version: row.version, updatedAt: new Date(0) });
        },
        findUnique: (args) => {
          const cur = this.store.get(args.where.pais);
          return Promise.resolve(cur ? { version: cur.version, updatedAt: new Date(0) } : null);
        },
      },
    };
    return fn(tx);
  }
}

const row = (over: Partial<PersistedCostPerKm> & { pais: string }): PersistedCostPerKm => ({
  costPerKmCents: 150,
  version: 1,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

describe('CostPerKmConfigService (F2.5 · costo/km DIRECTO del admin, per-país)', () => {
  it('sin fila (DB sin migrar) → degrada al env: PE 150, version 0', async () => {
    const service = new CostPerKmConfigService(new FakeRepo(), ENV, 0);
    expect(await service.getConfig(PAIS.PE)).toEqual({
      pais: PAIS.PE,
      costPerKmCents: 150,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → devuelve el valor persistido del admin (no el env)', async () => {
    const service = new CostPerKmConfigService(
      new FakeRepo([row({ pais: PAIS.PE, costPerKmCents: 175, version: 3 })]),
      ENV,
      0,
    );
    expect(await service.getCostPerKmCents(PAIS.PE)).toBe(175);
  });

  it('EC degrada a su propio env (50) cuando no hay fila', async () => {
    const service = new CostPerKmConfigService(new FakeRepo(), ENV, 0);
    expect(await service.getCostPerKmCents(PAIS.EC)).toBe(50);
  });

  it('DEGRADACIÓN HONESTA · repo falla → cae al env (NUNCA rompe), sin cachear el fallback', async () => {
    const service = new CostPerKmConfigService(new FakeRepo([], true), ENV, 10_000);
    expect(await service.getCostPerKmCents(PAIS.PE)).toBe(150); // env PE
  });

  it('país no soportado → ValidationError (no un default silencioso)', async () => {
    const service = new CostPerKmConfigService(new FakeRepo(), ENV, 0);
    await expect(service.getConfig('AR')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.getCostPerKmCents('US')).rejects.toBeInstanceOf(ValidationError);
  });

  it('listConfigs devuelve PE + EC (cada uno con su valor o su fallback)', async () => {
    const service = new CostPerKmConfigService(
      new FakeRepo([row({ pais: PAIS.PE, costPerKmCents: 160, version: 2 })]),
      ENV,
      0,
    );
    const list = await service.listConfigs();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.pais === PAIS.PE)?.costPerKmCents).toBe(160);
    expect(list.find((c) => c.pais === PAIS.EC)?.costPerKmCents).toBe(50); // fallback EC
  });

  it('replace (expectedVersion correcta) reemplaza el costo/km del país, bumpea version y autoaplica', async () => {
    const service = new CostPerKmConfigService(
      new FakeRepo([row({ pais: PAIS.PE, costPerKmCents: 150, version: 4 })]),
      ENV,
      10_000,
    );
    const out = await service.replace(PAIS.PE, 175, 4);
    expect(out).toMatchObject({ pais: PAIS.PE, costPerKmCents: 175, version: 5 });
    // El cambio se ve de inmediato (cache invalidado).
    expect(await service.getCostPerKmCents(PAIS.PE)).toBe(175);
  });

  it('primera escritura (sin fila, expectedVersion 0) arranca en version 1', async () => {
    const service = new CostPerKmConfigService(new FakeRepo(), ENV, 0);
    const out = await service.replace(PAIS.PE, 200, 0);
    expect(out.version).toBe(1);
    expect(out.costPerKmCents).toBe(200);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin la movió; sin lost update)', async () => {
    const repo = new FakeRepo([row({ pais: PAIS.PE, costPerKmCents: 150, version: 7 })]);
    const service = new CostPerKmConfigService(repo, ENV, 0);
    await expect(service.replace(PAIS.PE, 180, 6)).rejects.toThrow(ConflictError);
    expect(await service.getCostPerKmCents(PAIS.PE)).toBe(150); // intacto
  });

  it('cada país versiona por separado: editar PE no toca EC', async () => {
    const repo = new FakeRepo([
      row({ pais: PAIS.PE, costPerKmCents: 150, version: 1 }),
      row({ pais: PAIS.EC, costPerKmCents: 50, version: 1 }),
    ]);
    const service = new CostPerKmConfigService(repo, ENV, 0);
    await service.replace(PAIS.PE, 160, 1);
    expect(await service.getCostPerKmCents(PAIS.EC)).toBe(50);
    expect((await service.getConfig(PAIS.EC)).version).toBe(1);
  });

  it('rechaza un costo/km fuera de rango o no entero (céntimos Int, cota de cordura)', async () => {
    const service = new CostPerKmConfigService(new FakeRepo(), ENV, 0);
    await expect(service.replace(PAIS.PE, 0, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.replace(PAIS.PE, 10_001, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.replace(PAIS.PE, 12.5, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.replace('AR', 150, 0)).rejects.toBeInstanceOf(ValidationError);
  });
});
