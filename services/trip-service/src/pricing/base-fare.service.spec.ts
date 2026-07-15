/**
 * BaseFareService (F2.4) — tarifa base GLOBAL (banderazo + per-km + per-min) editable en caliente.
 * Repo fake en memoria (clean arch: el servicio depende del puerto), captura el outbox de la tx.
 */
import { describe, expect, it } from 'vitest';
import { BaseFareService } from './base-fare.service';
import { BASE_FARE_CENTS, PER_KM_CENTS, PER_MIN_CENTS } from '../trips/domain/fare';
import { pricingConfigChangedTotal } from '../trips/trip-metrics';
import type { BaseFareRepository, BaseFareTx, PersistedBaseFare } from './base-fare.repository';

/** Lee el valor actual del counter veo_pricing_config_changed_total para un `kind` (#3 observabilidad). */
async function readPricingChanged(kind: string): Promise<number> {
  const m = await pricingConfigChangedTotal.get();
  return m.values.filter((v) => v.labels.kind === kind).reduce((s, v) => s + v.value, 0);
}

class FakeRepo implements BaseFareRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(private config: PersistedBaseFare | null = null) {}

  find(): Promise<PersistedBaseFare | null> {
    return Promise.resolve(this.config);
  }

  async runInTx<T>(fn: (tx: BaseFareTx) => Promise<T>): Promise<T> {
    const tx: BaseFareTx = {
      baseFareConfig: {
        // CAS: solo "actualiza" si la fila existe Y su versión coincide con el WHERE (espejo del UPDATE ... WHERE version=).
        updateMany: (args) => {
          if (this.config?.version === args.where.version) {
            this.config = {
              baseFareCents: args.data.baseFareCents as number,
              perKmCents: args.data.perKmCents as number,
              perMinCents: args.data.perMinCents as number,
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            baseFareCents: args.data.baseFareCents as number,
            perKmCents: args.data.perKmCents as number,
            perMinCents: args.data.perMinCents as number,
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

describe('BaseFareService (F2.4 · banderazo + per-km + per-min)', () => {
  it('sin fila (DB sin migrar) → getConfig devuelve los DEFAULTS del código (no S/0)', async () => {
    const service = new BaseFareService(new FakeRepo(null), 0);
    const cfg = await service.getConfig();
    expect(cfg).toEqual({
      baseFareCents: BASE_FARE_CENTS,
      perKmCents: PER_KM_CENTS,
      perMinCents: PER_MIN_CENTS,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → getConfig devuelve los valores persistidos', async () => {
    const repo = new FakeRepo({
      baseFareCents: 700,
      perKmCents: 130,
      perMinCents: 35,
      version: 5,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BaseFareService(repo, 0);
    expect(await service.getConfig()).toEqual({
      baseFareCents: 700,
      perKmCents: 130,
      perMinCents: 35,
      version: 5,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('replace (expectedVersion correcta) bumpea version y emite el evento en la misma tx', async () => {
    const repo = new FakeRepo({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BaseFareService(repo, 0);
    const out = await service.replace(800, 150, 40, 4); // expectedVersion=4 (la vigente)
    expect(out.version).toBe(5); // 4 + 1
    expect(out.baseFareCents).toBe(800);
    expect(out.perKmCents).toBe(150);
    expect(out.perMinCents).toBe(40);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'pricing.base_fare_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado).
    expect(await service.getConfig()).toMatchObject({ baseFareCents: 800, version: 5 });
  });

  it('primera escritura (sin fila previa, expectedVersion 0) arranca en version 1', async () => {
    const service = new BaseFareService(new FakeRepo(null), 0);
    expect((await service.replace(600, 120, 30, 0)).version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin cambió el config; sin lost update)', async () => {
    const repo = new FakeRepo({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 7,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BaseFareService(repo, 0);
    // El admin cargó v6, pero la vigente ya es v7 (otro la movió) → rechazo honesto, NO pisa.
    await expect(service.replace(900, 200, 50, 6)).rejects.toThrow(/cambió/);
    // La config NO se tocó: sigue v7 con los valores viejos, y NO se emitió evento.
    expect(await service.getConfig()).toMatchObject({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 7,
    });
    expect(repo.outboxEvents).toEqual([]);
  });

  it('CAS · primer write pero la fila ya existe (expectedVersion 0 stale) → ConflictError', async () => {
    const repo = new FakeRepo({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 3,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BaseFareService(repo, 0);
    await expect(service.replace(900, 200, 50, 0)).rejects.toThrow(/inicializada/);
    expect(repo.outboxEvents).toEqual([]);
  });

  it('#3 observabilidad: un replace EXITOSO bumpea veo_pricing_config_changed_total{kind=base_fare}; un conflicto NO', async () => {
    const before = await readPricingChanged('base_fare');
    const repo = new FakeRepo({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 4,
      updatedAt: new Date(0).toISOString(),
    });
    const service = new BaseFareService(repo, 0);
    await service.replace(800, 150, 40, 4); // éxito → +1
    expect(await readPricingChanged('base_fare')).toBe(before + 1);
    await expect(service.replace(800, 150, 40, 4)).rejects.toThrow(/cambió/); // stale → 409, NO bumpea
    expect(await readPricingChanged('base_fare')).toBe(before + 1);
  });
});
