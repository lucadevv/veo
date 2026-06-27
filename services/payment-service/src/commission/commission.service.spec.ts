/**
 * CommissionService (F2.7 · ADR-017 §1.6 / ADR-015 §11.2) — comisión por modo editable en caliente.
 * Repo fake en memoria (clean arch: el servicio depende del puerto), captura el outbox de la tx. Cubre:
 * la resolución por modo (carpooling→0, on-demand→tasa), el GUARD LEGAL (carpooling 0 aunque la config diga
 * otra cosa — no hay forma de setearlo >0), el CAS del config, y la DEGRADACIÓN HONESTA a la tasa del env.
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

/** ConfigService de prueba: solo se le pide COMMISSION_RATE (float 0..1 del env, fallback honesto). */
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

describe('CommissionService (F2.7 · comisión por modo)', () => {
  it('sin fila (DB sin migrar) → getConfig degrada a la tasa del env (2000 bps = 20%), version 0', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    expect(await service.getConfig()).toEqual({
      onDemandRateBps: 2000,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('con fila → getConfig devuelve la tasa persistida', async () => {
    const repo = new FakeRepo({ onDemandRateBps: 1500, version: 5, updatedAt: new Date(0).toISOString() });
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    expect(await service.getOnDemandRateBps()).toBe(1500);
  });

  it('GUARD LEGAL · resolveRateBps(CARPOOLING) es 0 SIEMPRE, aunque la config on-demand sea alta', async () => {
    const repo = new FakeRepo({ onDemandRateBps: 9999, version: 1, updatedAt: new Date(0).toISOString() });
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(0);
    // …y el on-demand sí refleja la config.
    expect(await service.resolveRateBps(ChargeMode.ON_DEMAND)).toBe(9999);
  });

  it('DEGRADACIÓN HONESTA · si el repo falla, resolveRateBps(ON_DEMAND) cae a la tasa del env, NUNCA rompe ni cae a 0', async () => {
    const service = new CommissionService(new FakeRepo(null, true), fakeConfig(0.18), 0);
    expect(await service.resolveRateBps(ChargeMode.ON_DEMAND)).toBe(1800); // 0.18 * 10000
    // El carpooling sigue 0 (guard legal) incluso con la config caída.
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(0);
  });

  it('replace (expectedVersion correcta) bumpea version y emite payment.commission_updated en la misma tx', async () => {
    const repo = new FakeRepo({ onDemandRateBps: 2000, version: 4, updatedAt: new Date(0).toISOString() });
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    const out = await service.replace(1500, 4); // expectedVersion=4 (la vigente)
    expect(out.version).toBe(5);
    expect(out.onDemandRateBps).toBe(1500);
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'payment.commission_updated' },
    ]);
    // El cambio se ve de inmediato (cache invalidado).
    expect(await service.getOnDemandRateBps()).toBe(1500);
  });

  it('primera escritura (sin fila, expectedVersion 0) arranca en version 1', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    expect((await service.replace(2500, 0)).version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin la movió; sin lost update ni evento)', async () => {
    const repo = new FakeRepo({ onDemandRateBps: 2000, version: 7, updatedAt: new Date(0).toISOString() });
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    await expect(service.replace(1000, 6)).rejects.toThrow(ConflictError);
    expect(await service.getOnDemandRateBps()).toBe(2000); // intacto
    expect(repo.outboxEvents).toEqual([]);
  });

  it('rechaza una tasa fuera de [0,10000] bps (cero float, cero >100%)', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    await expect(service.replace(10_001, 0)).rejects.toThrow(ConflictError);
    await expect(service.replace(-1, 0)).rejects.toThrow(ConflictError);
  });
});
