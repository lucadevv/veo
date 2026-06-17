/**
 * FuelSurchargeService (B4) — el recargo de combustible se DERIVA de precio_por_litro ÷ rendimiento.
 * Repo fake en memoria (clean arch: el servicio depende del puerto), captura el outbox de la tx.
 */
import { describe, expect, it } from 'vitest';
import { FuelSurchargeService } from './fuel-surcharge.service';
import { pricingConfigChangedTotal } from '../trips/trip-metrics';
import type {
  FuelSurchargeRepository,
  FuelSurchargeTx,
  PersistedFuelSurcharge,
} from './fuel-surcharge.repository';

/** Lee el valor actual del counter veo_pricing_config_changed_total para un `kind` (#3 observabilidad). */
async function readPricingChanged(kind: string): Promise<number> {
  const m = await pricingConfigChangedTotal.get();
  return m.values.filter((v) => v.labels.kind === kind).reduce((s, v) => s + v.value, 0);
}

class FakeRepo implements FuelSurchargeRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(private config: PersistedFuelSurcharge | null = null) {}

  find(): Promise<PersistedFuelSurcharge | null> {
    return Promise.resolve(this.config);
  }

  async runInTx<T>(fn: (tx: FuelSurchargeTx) => Promise<T>): Promise<T> {
    const tx: FuelSurchargeTx = {
      fuelSurchargeConfig: {
        // CAS: solo "actualiza" si la fila existe Y su versión coincide con el WHERE (espejo del UPDATE ... WHERE version=).
        updateMany: (args) => {
          if (this.config && this.config.version === args.where.version) {
            this.config = {
              fuelPricePerLiterCents: args.data.fuelPricePerLiterCents as number,
              kmPerLiter: args.data.kmPerLiter as number,
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            fuelPricePerLiterCents: args.data.fuelPricePerLiterCents as number,
            kmPerLiter: args.data.kmPerLiter as number,
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

describe('FuelSurchargeService (B4 · derivado de precio÷rendimiento)', () => {
  it('sin fila (DB vacía) → getPerKmCents 0 (degradación honesta: sin recargo)', async () => {
    const service = new FuelSurchargeService(new FakeRepo(null), 0);
    expect(await service.getPerKmCents()).toBe(0);
    const cfg = await service.getConfig();
    expect(cfg).toEqual({
      fuelPricePerLiterCents: 0,
      kmPerLiter: 0,
      perKmCents: 0,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → getPerKmCents DERIVA = round(precio ÷ rendimiento)', async () => {
    // S/4.20/L (420 céntimos) ÷ 12 km/L = 35 céntimos/km.
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 5,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new FuelSurchargeService(repo, 0);
    expect(await service.getPerKmCents()).toBe(35);
  });

  it('rendimiento 0 → getPerKmCents 0 (degradación honesta, sin división por cero)', async () => {
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 0,
      version: 1,
      updatedAt: new Date(0).toISOString(),
    });
    expect(await new FuelSurchargeService(repo, 0).getPerKmCents()).toBe(0);
  });

  it('replace (expectedVersion correcta) bumpea version, emite el evento en la misma tx y re-deriva el per-km', async () => {
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 100,
      kmPerLiter: 10,
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new FuelSurchargeService(repo, 0);
    const out = await service.replace(480, 12, 4); // expectedVersion=4 (la vigente); 480 ÷ 12 = 40 céntimos/km
    expect(out.version).toBe(5); // 4 + 1
    expect(out.fuelPricePerLiterCents).toBe(480);
    expect(out.kmPerLiter).toBe(12);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'fuel.surcharge_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado) y el per-km se re-deriva: 480÷12 = 40.
    expect(await service.getPerKmCents()).toBe(40);
  });

  it('primera escritura (sin fila previa, expectedVersion 0) arranca en version 1', async () => {
    const service = new FuelSurchargeService(new FakeRepo(null), 0);
    expect((await service.replace(420, 12, 0)).version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin cambió el config; sin lost update)', async () => {
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 7,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new FuelSurchargeService(repo, 0);
    // El admin cargó v6, pero la vigente ya es v7 (otro la movió) → rechazo honesto, NO pisa.
    await expect(service.replace(500, 10, 6)).rejects.toThrow(/cambió/);
    // La config NO se tocó: sigue v7 con los valores viejos, y NO se emitió evento.
    expect(await service.getConfig()).toMatchObject({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 7,
    });
    expect(repo.outboxEvents).toEqual([]);
  });

  it('CAS · primer write pero la fila ya existe (expectedVersion 0 stale) → ConflictError', async () => {
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 3,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new FuelSurchargeService(repo, 0);
    await expect(service.replace(500, 10, 0)).rejects.toThrow(/inicializado/);
    expect(repo.outboxEvents).toEqual([]);
  });

  it('#3 observabilidad: un replace EXITOSO bumpea veo_pricing_config_changed_total{kind=fuel_surcharge}; un conflicto NO', async () => {
    const before = await readPricingChanged('fuel_surcharge');
    const repo = new FakeRepo({
      fuelPricePerLiterCents: 100,
      kmPerLiter: 10,
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new FuelSurchargeService(repo, 0);
    await service.replace(480, 12, 4); // éxito → +1
    expect(await readPricingChanged('fuel_surcharge')).toBe(before + 1);
    await expect(service.replace(480, 12, 4)).rejects.toThrow(/cambió/); // stale → 409, NO bumpea
    expect(await readPricingChanged('fuel_surcharge')).toBe(before + 1);
  });
});
