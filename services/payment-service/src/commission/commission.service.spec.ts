/**
 * CommissionService (F2.7 · comisión por modo · CAS DESACOPLADA #3) — dos tasas con DOS versions INDEPENDIENTES:
 * la comisión ON-DEMAND (descontada al conductor, CAS sobre `version`) y el service fee CARPOOLING (sumado al
 * pasajero, CAS sobre `carpoolingFeeVersion`). Repo fake en memoria (clean arch: el servicio depende del puerto),
 * captura el outbox de la tx. Cubre: la resolución por modo, el CAS por carril, el DESACOPLE (editar uno no 409ea
 * al otro) y la DEGRADACIÓN HONESTA (on-demand a la tasa del env, carpooling a 0). El desacople contra Postgres
 * REAL vive en test/commission-version-split.e2e.spec.ts (es money → no se mockea la DB del invariante clave).
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
        // CAS por COLUMNA: el where filtra `version` (on-demand/PSP) O `carpoolingFeeVersion` (carpooling). El
        // fake matchea la que venga presente → modela que los dos carriles NO comparten predicado (desacople).
        updateMany: (args) => {
          const w = args.where;
          const matches =
            this.config != null &&
            ((w.version !== undefined && this.config.version === w.version) ||
              (w.carpoolingFeeVersion !== undefined &&
                this.config.carpoolingFeeVersion === w.carpoolingFeeVersion));
          if (this.config && matches) {
            // MERGE (no replace): `...args.data` trae SOLO los campos tocados (la tasa + su version) y preserva
            // el otro carril tal cual → cubre on-demand, carpooling y PSP con la misma rama.
            this.config = {
              ...this.config,
              ...args.data,
              updatedAt: new Date(0).toISOString(),
            } as PersistedCommission;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
        create: (args) => {
          this.config = {
            ...(args.data as object),
            updatedAt: new Date(0).toISOString(),
          } as PersistedCommission;
          return Promise.resolve({
            version: this.config.version,
            carpoolingFeeVersion: this.config.carpoolingFeeVersion,
            onDemandRateBps: this.config.onDemandRateBps,
            carpoolingFeeBps: this.config.carpoolingFeeBps,
            updatedAt: new Date(0),
          });
        },
        findUnique: () =>
          Promise.resolve(
            this.config
              ? {
                  version: this.config.version,
                  carpoolingFeeVersion: this.config.carpoolingFeeVersion,
                  onDemandRateBps: this.config.onDemandRateBps,
                  carpoolingFeeBps: this.config.carpoolingFeeBps,
                  updatedAt: new Date(0),
                }
              : null,
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
  carpoolingFeeVersion: 1,
  updatedAt: new Date(0).toISOString(),
  ...over,
});

describe('CommissionService (F2.7 · comisión por modo · CAS desacoplada)', () => {
  it('sin fila (DB sin migrar) → getConfig degrada: on-demand al env (2000 bps), carpooling 0, ambas versions 0', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    expect(await service.getConfig()).toEqual({
      onDemandRateBps: 2000,
      carpoolingFeeBps: 0,
      version: 0,
      carpoolingFeeVersion: 0,
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

  // ── replaceOnDemandRate: edita SOLO on-demand, CAS sobre `version` ──────────────────────
  it('replaceOnDemandRate (version correcta) edita SOLO on-demand, bumpea `version` (NO carpoolingFeeVersion) y emite el evento', async () => {
    const repo = new FakeRepo(
      row({ onDemandRateBps: 2000, carpoolingFeeBps: 800, version: 4, carpoolingFeeVersion: 2 }),
    );
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    const out = await service.replaceOnDemandRate(1500, 4);
    expect(out.version).toBe(5);
    expect(out.onDemandRateBps).toBe(1500);
    expect(out.carpoolingFeeBps).toBe(800); // carpooling INTACTO
    expect(out.carpoolingFeeVersion).toBe(2); // su version NO se movió
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'payment.commission_updated' },
    ]);
    expect(await service.getOnDemandRateBps()).toBe(1500); // cache invalidado
  });

  it('primera escritura on-demand (sin fila, version 0) → version 1, carpooling 0, carpoolingFeeVersion 0', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    const out = await service.replaceOnDemandRate(2500, 0);
    expect(out.version).toBe(1);
    expect(out.onDemandRateBps).toBe(2500);
    expect(out.carpoolingFeeBps).toBe(0);
    expect(out.carpoolingFeeVersion).toBe(0);
  });

  it('CAS on-demand · version STALE → ConflictError (sin lost update ni evento)', async () => {
    const repo = new FakeRepo(row({ onDemandRateBps: 2000, version: 7 }));
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    await expect(service.replaceOnDemandRate(1000, 6)).rejects.toThrow(ConflictError);
    expect(await service.getOnDemandRateBps()).toBe(2000); // intacto
    expect(repo.outboxEvents).toEqual([]);
  });

  it('replaceOnDemandRate rechaza una tasa fuera de [0,10000] bps (cero float, cero >100%)', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    await expect(service.replaceOnDemandRate(10_001, 0)).rejects.toThrow(ConflictError);
    await expect(service.replaceOnDemandRate(-1, 0)).rejects.toThrow(ConflictError);
  });

  // ── replaceCarpoolingFee: edita SOLO carpooling, CAS sobre `carpoolingFeeVersion` ────────
  it('replaceCarpoolingFee (carpoolingFeeVersion correcta) edita SOLO carpooling, bumpea `carpoolingFeeVersion` (NO version) y emite el evento', async () => {
    const repo = new FakeRepo(
      row({ onDemandRateBps: 2000, carpoolingFeeBps: 0, version: 7, carpoolingFeeVersion: 3 }),
    );
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    const out = await service.replaceCarpoolingFee(1200, 3);
    expect(out.carpoolingFeeVersion).toBe(4);
    expect(out.carpoolingFeeBps).toBe(1200);
    expect(out.onDemandRateBps).toBe(2000); // on-demand INTACTO
    expect(out.version).toBe(7); // su version NO se movió
    expect(repo.outboxEvents).toEqual([
      { aggregateId: 'GLOBAL', eventType: 'payment.commission_updated' },
    ]);
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(1200); // cache invalidado
  });

  it('primera escritura carpooling (sin fila, version 0) → carpoolingFeeVersion 1, on-demand = env, version 0', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.18), 0);
    const out = await service.replaceCarpoolingFee(800, 0);
    expect(out.carpoolingFeeVersion).toBe(1);
    expect(out.carpoolingFeeBps).toBe(800);
    expect(out.onDemandRateBps).toBe(1800); // fallback del env (NO 0: no regala la comisión on-demand)
    expect(out.version).toBe(0);
  });

  it('CAS carpooling · carpoolingFeeVersion STALE → ConflictError (sin lost update ni evento)', async () => {
    const repo = new FakeRepo(row({ carpoolingFeeBps: 500, carpoolingFeeVersion: 9 }));
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    await expect(service.replaceCarpoolingFee(1000, 8)).rejects.toThrow(ConflictError);
    expect(await service.resolveRateBps(ChargeMode.CARPOOLING)).toBe(500); // intacto
    expect(repo.outboxEvents).toEqual([]);
  });

  it('replaceCarpoolingFee rechaza una tasa fuera de [0,10000] bps', async () => {
    const service = new CommissionService(new FakeRepo(null), fakeConfig(0.2), 0);
    await expect(service.replaceCarpoolingFee(10_001, 0)).rejects.toThrow(ConflictError);
    await expect(service.replaceCarpoolingFee(-1, 0)).rejects.toThrow(ConflictError);
  });

  // ── EL DESACOPLE (invariante de UX + money) ─────────────────────────────────────────────
  it('DESACOPLE · editar carpooling NO invalida la `version` de on-demand → sin 409 cruzado, valores no se pisan', async () => {
    const repo = new FakeRepo(
      row({ onDemandRateBps: 2000, carpoolingFeeBps: 0, version: 5, carpoolingFeeVersion: 5 }),
    );
    const service = new CommissionService(repo, fakeConfig(0.2), 0);

    // (a) on-demand bumpea SOLO su version; la de carpooling queda igual.
    const afterOnDemand = await service.replaceOnDemandRate(1500, 5);
    expect(afterOnDemand.version).toBe(6);
    expect(afterOnDemand.carpoolingFeeVersion).toBe(5); // NO se movió

    // carpooling bumpea SOLO carpoolingFeeVersion; la de on-demand (6) queda igual.
    const afterCarpooling = await service.replaceCarpoolingFee(1200, 5);
    expect(afterCarpooling.carpoolingFeeVersion).toBe(6);
    expect(afterCarpooling.version).toBe(6); // NO se movió

    // (b) tras editar carpooling, un replaceOnDemandRate con la version de on-demand VIGENTE (6) SÍ funciona:
    // antes esto 409eaba (carpooling había bumpeado la version COMPARTIDA). Ahora NO hay cruce.
    const afterOnDemand2 = await service.replaceOnDemandRate(1800, 6);
    expect(afterOnDemand2.version).toBe(7);

    // (c) los valores de plata quedan correctos y no se pisaron entre carriles.
    const final = await service.getConfig();
    expect(final.onDemandRateBps).toBe(1800);
    expect(final.carpoolingFeeBps).toBe(1200);
    expect(final.version).toBe(7);
    expect(final.carpoolingFeeVersion).toBe(6);
  });

  // ── P-B (ADR-022) · fee del PSP por método (editable, CAS sobre `version`) ───────────────
  it('resolvePspFeeBps: por método desde la config; CASH → 0 (no pasa por el PSP)', async () => {
    const service = new CommissionService(
      new FakeRepo(
        row({ yapeFeeBps: 200, plinFeeBps: 150, cardFeeBps: 350, pagoefectivoFeeBps: 400 }),
      ),
      fakeConfig(0.2),
      0,
    );
    expect(await service.resolvePspFeeBps('YAPE')).toBe(200);
    expect(await service.resolvePspFeeBps('CARD')).toBe(350);
    expect(await service.resolvePspFeeBps('CASH')).toBe(0);
  });

  it('resolvePspFeeBps: sin fees seteados (config vieja / degradada) → 0 (degradación honesta)', async () => {
    const service = new CommissionService(new FakeRepo(row({})), fakeConfig(0.2), 0);
    expect(await service.resolvePspFeeBps('YAPE')).toBe(0);
  });

  it('replacePspFees (CAS ok): setea los 4 fees + bumpea version, PRESERVANDO las comisiones', async () => {
    const repo = new FakeRepo(row({ onDemandRateBps: 2000, carpoolingFeeBps: 500, version: 3 }));
    const service = new CommissionService(repo, fakeConfig(0.2), 0);
    const out = await service.replacePspFees(
      { yapeFeeBps: 200, plinFeeBps: 150, cardFeeBps: 350, pagoefectivoFeeBps: 400 },
      3,
    );
    expect(out.version).toBe(4);
    expect(out.yapeFeeBps).toBe(200);
    expect(out.cardFeeBps).toBe(350);
    expect(out.onDemandRateBps).toBe(2000); // comisión preservada (no la pisa el PUT de fee PSP)
    expect(out.carpoolingFeeBps).toBe(500);
    expect(await service.resolvePspFeeBps('PLIN')).toBe(150); // el cambio se ve de inmediato
  });

  it('replacePspFees (version STALE) → ConflictError (CAS, sin lost update)', async () => {
    const service = new CommissionService(new FakeRepo(row({ version: 5 })), fakeConfig(0.2), 0);
    await expect(
      service.replacePspFees(
        { yapeFeeBps: 100, plinFeeBps: 100, cardFeeBps: 100, pagoefectivoFeeBps: 100 },
        2,
      ),
    ).rejects.toThrow(ConflictError);
  });

  it('replacePspFees rechaza un fee fuera de [0,10000] bps', async () => {
    const service = new CommissionService(new FakeRepo(row({ version: 1 })), fakeConfig(0.2), 0);
    await expect(
      service.replacePspFees(
        { yapeFeeBps: 10_001, plinFeeBps: 0, cardFeeBps: 0, pagoefectivoFeeBps: 0 },
        1,
      ),
    ).rejects.toThrow();
  });
});
