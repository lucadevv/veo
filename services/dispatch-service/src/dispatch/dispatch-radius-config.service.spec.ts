/**
 * DispatchRadiusConfigService — foco en la POLÍTICA v2 y el feature-flag: getPolicy() por default (v1),
 * fallthrough v1, y el PUT que persiste la política v2 + INVALIDA el cache (el cambio se ve al instante).
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import {
  parsePolicyV2,
  type DispatchPolicyV2,
} from './dispatch-policy';
import type {
  DispatchRadiusConfigRepository,
  PersistedRadiusConfig,
  RadiusConfigTx,
} from './dispatch-radius-config.repository';

const V2: DispatchPolicyV2 = {
  FIXED: {
    initialRadiusKm: 0.6,
    incrementKm: 0.3,
    maxRadiusKm: 1.5,
    targetDrivers: 4,
    offerTimeoutSec: 25,
    expandIntervalSec: 8,
  },
  PUJA: { broadcastRadiusKm: 1.2, bidWindowSec: 90 },
};

interface RawRow {
  nearbyKRing: number;
  matchKRing: number;
  offerTimeoutMs: number;
  bidWindowSec: number;
  policyVersion: string;
  policyV2raw: unknown;
  version: number;
  updatedAt: Date;
}

/** Repo en memoria (mismo contrato que el adaptador Prisma). Registra el outbox emitido. */
class InMemoryConfigRepo implements DispatchRadiusConfigRepository {
  row: RawRow | null = null;
  readonly outbox: string[] = [];

  async find(): Promise<PersistedRadiusConfig | null> {
    if (!this.row) return null;
    return {
      nearbyKRing: this.row.nearbyKRing,
      matchKRing: this.row.matchKRing,
      offerTimeoutMs: this.row.offerTimeoutMs,
      bidWindowSec: this.row.bidWindowSec,
      policyVersion: this.row.policyVersion,
      policyV2: parsePolicyV2(this.row.policyV2raw),
      version: this.row.version,
      updatedAt: this.row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: RadiusConfigTx) => Promise<T>): Promise<T> {
    const self = this;
    const tx: RadiusConfigTx = {
      dispatchRadiusConfig: {
        upsert: async ({ create, update }) => {
          const data = (self.row ? update : create) as Record<string, unknown>;
          const rawPolicy = data.policyV2 === Prisma.DbNull ? null : data.policyV2;
          self.row = {
            nearbyKRing: data.nearbyKRing as number,
            matchKRing: data.matchKRing as number,
            offerTimeoutMs: data.offerTimeoutMs as number,
            bidWindowSec: data.bidWindowSec as number,
            policyVersion: data.policyVersion as string,
            policyV2raw: rawPolicy,
            version: data.version as number,
            updatedAt: new Date(),
          };
          return { version: self.row.version, updatedAt: self.row.updatedAt };
        },
      },
      outboxEvent: {
        create: async ({ data }) => {
          self.outbox.push(data.eventType);
        },
      },
    };
    return fn(tx);
  }
}

function makeService(cacheTtlMs = 10_000) {
  const repo = new InMemoryConfigRepo();
  const svc = new DispatchRadiusConfigService(repo, cacheTtlMs, {
    offerTimeoutMs: 20_000,
    bidWindowSec: 60,
  });
  return { svc, repo };
}

const BASE = { nearbyKRing: 3, matchKRing: 4, offerTimeoutMs: 20_000, bidWindowSec: 60 };

describe('DispatchRadiusConfigService — política v2 + feature-flag', () => {
  it('getPolicy() sin fila → default v1 (v2 null)', async () => {
    const { svc } = makeService();
    expect(await svc.getPolicy()).toEqual({ policyVersion: 'v1', v2: null });
  });

  it('getConfig() sin fila expone policyVersion v1 + policyV2 null (version 0)', async () => {
    const { svc } = makeService();
    const cfg = await svc.getConfig();
    expect(cfg.policyVersion).toBe('v1');
    expect(cfg.policyV2).toBeNull();
    expect(cfg.version).toBe(0);
  });

  it('PUT v1 → getPolicy() sigue en v1 (fallthrough), aunque venga policyV2 lo ignora', async () => {
    const { svc } = makeService();
    await svc.replaceConfig({ ...BASE, policyVersion: 'v1', policyV2: null });
    expect(await svc.getPolicy()).toEqual({ policyVersion: 'v1', v2: null });
    // Y las ventanas/k-rings siguen funcionando.
    expect(await svc.getWindows()).toEqual({ offerTimeoutMs: 20_000, bidWindowSec: 60 });
    expect(await svc.getKRings()).toEqual({ nearbyKRing: 3, matchKRing: 4 });
  });

  it('PUT v2 → persiste la política y getPolicy()/getConfig() la reflejan', async () => {
    const { svc, repo } = makeService();
    await svc.replaceConfig({ ...BASE, policyVersion: 'v2', policyV2: V2 });
    expect(await svc.getPolicy()).toEqual({ policyVersion: 'v2', v2: V2 });
    const cfg = await svc.getConfig();
    expect(cfg.policyVersion).toBe('v2');
    expect(cfg.policyV2).toEqual(V2);
    // Emitió el evento de outbox del cambio.
    expect(repo.outbox).toContain('dispatch.radius_config_updated');
  });

  it('el PUT INVALIDA el cache: el cambio v1→v2 se ve al instante (no espera el TTL)', async () => {
    const { svc } = makeService(60_000); // TTL largo: si no invalidara, el 2º read seguiría en v1
    await svc.replaceConfig({ ...BASE, policyVersion: 'v1', policyV2: null });
    expect((await svc.getPolicy()).policyVersion).toBe('v1'); // cachea v1
    await svc.replaceConfig({ ...BASE, policyVersion: 'v2', policyV2: V2 });
    // Sin invalidación, este read devolvería el v1 cacheado; con invalidación → v2 fresco.
    expect((await svc.getPolicy()).policyVersion).toBe('v2');
  });
});
