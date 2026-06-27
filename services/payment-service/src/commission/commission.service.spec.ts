/**
 * CommissionService (F2.7 · ADR-017 §1.6 / ADR-015 §11.2) — comisión por modo editable en caliente, DOS tasas:
 * la comisión ON-DEMAND (descontada al conductor) y el service fee CARPOOLING (sumado al pasajero). Repo fake en
 * memoria (clean arch: el servicio depende del puerto), captura el outbox de la tx. Cubre: la resolución por modo
 * (on-demand→onDemandRateBps, carpooling→carpoolingFeeBps), el CAS del config, y la DEGRADACIÓN HONESTA (on-demand
 * a la tasa del env, carpooling a 0).
 */
import { describe, expect, it } from 'vitest';
import { ConflictError } from '@veo/utils';
import type { ConfigService } from '@nestjs/config';
import { CommissionService } from './commission.service';
import { ChargeMode } from '../payments/payment.policy';
import type {
  CommissionRepository,
  CommissionTx,
  PersistedCommission,
} from './commission.repository';
import type { Env } from '../config/env.schema';

/** ConfigService de prueba: solo se le pide COMMISSION_RATE (float 0..1 del env, fallback honesto on-demand). */
function fakeConfig(commissionRate = 0.2): ConfigService<Env, true> {
  return { getOrThrow: () => commissionRate } as unknown as ConfigService<Env, true>;
}

class FakeRepo implements CommissionRepository {
  outboxEvents: { aggregateId: string; eventType: string }[] = [];
  constructor(
    private config: PersistedCommission | null = null,
    /** Si true, `find` lanza (simula DB caída/sin migrar → degradación honesta al env). */
    private failFind = false,
  ) {}

  find(): Promise<PersistedCommission | null> {
    if (this.failFind) return Promise.reject(new Error('DB down'));
    return Promise.resolve(this.config);
  }

  async runInTx<T>(fn: (tx: CommissionTx) => Promise<T>): Promise<T> {
    const tx: CommissionTx = {
      commissionConfig: {
        updateMany: (args) => {
          if (this.config?.version === args.where.version) {
            this.config = {
              onDemandRateBps: args.data.onDemandRateBps as number,
              carpoolingFeeBps: args.data.carpoolingFeeBps as number,
              version: args.data.version as number,
              updatedAt: new Date(0).toISOString(),
            };
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            onDemandRateBps: args.data.onDemandRateBps as number,
            carpoolingFeeBps: args.data.carpoolingFeeBps as number,
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

const row = (over: Partial<PersistedCommission>): PersistedCommission => ({
  onDemandRateBps: 2000,
  carpoolingFeeBps: 0,
  version: 1,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

describe('CommissionService (F2.7 · comisión por modo · dos tasas)', () => {
  it('sin fila (DB sin migrar) → getConfig degrada: on-demand al env (2000 bps), carpooling 0, version 0', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    expect(await service.getConfig()).toEqual({
      onDemandRateBps: 2000,
      carpoolingFeeBps: 0,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → getConfig devuelve ambas tasas persistidas', async () => {
    const service = new CommissionService(
      new FakeRepo(row({ onDemandRateBps: 1500, carpoolingFeeBps: 1200, version: 5 })),
      fakeConfig(0.2),
      0,
    );
    expect(await service.getOnDemandRateBps()).toBe(1500);
    expect((await service.getConfig()).carpoolingFeeBps).toBe(1200);
  });

  it('resolveRateBps por modo: CARPOOLING → carpoolingFeeBps, ON_DEMAND → onDemandRateBps', async () => {
    const service = new CommissionService(
      new FakeRepo(row({ onDemandRateBps: 2000, carpoolingFeeBps: 1500 })),
      fakeConfig(0.2),
      0,
    );
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(1500);
    expect(await service.resolveRateBps(ChargeMode.ON_DEMAND)).toBe(2000);
  });

  it('DEGRADACIÓN HONESTA · repo falla → ON_DEMAND cae al env (NUNCA 0), CARPOOLING cae a 0 (sin fee)', async () => {
    const service = new CommissionService(new FakeRepo(null, true), fakeConfig(0.18), 0);
    expect(await service.resolveRateBps(ChargeMode.ON_DEMAND)).toBe(1800); // 0.18 * 10000
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(0); // sin fee al degradar
  });

  it('replace (expectedVersion correcta) reemplaza AMBAS tasas, bumpea version y emite el evento en la misma tx', async () => {
    const repo = new FakeRepo(row({ onDemandRateBps: 2000, carpoolingFeeBps: 0, version: 4 }));
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    const out = await service.replace(1500, 1200, 4); // on-demand 15%, carpooling fee 12%, version 4
    expect(out.version).toBe(5);
    expect(out.onDemandRateBps).toBe(1500);
    expect(out.carpoolingFeeBps).toBe(1200);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'payment.commission_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado).
    expect(await service.getOnDemandRateBps()).toBe(1500);
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(1200);
  });

  it('primera escritura (sin fila, expectedVersion 0) arranca en version 1 con ambas tasas', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    const out = await service.replace(2500, 800, 0);
    expect(out.version).toBe(1);
    expect(out.onDemandRateBps).toBe(2500);
    expect(out.carpoolingFeeBps).toBe(800);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin la movió; sin lost update ni evento)', async () => {
    const repo = new FakeRepo(row({ onDemandRateBps: 2000, version: 7 }));
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    await expect(service.replace(1000, 500, 6)).rejects.toThrow(ConflictError);
    expect(await service.getOnDemandRateBps()).toBe(2000); // intacto
    expect(repo.outboxEvents).toEqual([]);
  });

  it('rechaza una tasa fuera de [0,10000] bps en cualquiera de las dos (cero float, cero >100%)', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    await expect(service.replace(10_001, 0, 0)).rejects.toThrow(ConflictError); // on-demand fuera de rango
    await expect(service.replace(-1, 0, 0)).rejects.toThrow(ConflictError);
    await expect(service.replace(2000, 10_001, 0)).rejects.toThrow(ConflictError); // carpooling fuera de rango
    await expect(service.replace(2000, -1, 0)).rejects.toThrow(ConflictError);
  });
});
