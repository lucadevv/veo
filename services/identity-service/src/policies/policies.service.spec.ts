import { describe, it, expect, vi } from 'vitest';
import {
  ConcurrencyConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { PoliciesService } from './policies.service';
import type { PolicyVersionData, UpsertPolicyData } from './policies.repository';
import type { Policy, PolicyVersion } from '../generated/prisma';

/**
 * Doble de PoliciesRepository: `runInTransaction` ejecuta el work con un tx ficticio; `findByKeyTx` devuelve el
 * estado "actual"; `upsertTx` echoa la data como haría la DB; `enqueueOutbox` captura el envelope emitido;
 * `appendVersionsTx` captura las filas de historial. Así el spec verifica la LÓGICA del service (validación Zod,
 * candado mandatory, bump, historial, outbox) sin Prisma real. `hasHistory` simula si la política YA tiene historia.
 */
function makeRepo(current: Policy | null, hasHistory = false) {
  const captured: {
    upsert?: UpsertPolicyData;
    versions?: PolicyVersionData[];
    envelope?: { eventType: string; payload: Record<string, unknown> };
    outboxAggregateId?: string;
  } = {};

  const upsertTx = vi.fn(async (_tx: unknown, data: UpsertPolicyData): Promise<Policy> => {
    captured.upsert = data;
    return {
      key: data.key,
      family: data.family,
      enabled: data.enabled,
      params: data.params as Policy['params'],
      mandatory: data.mandatory,
      version: data.version,
      updatedBy: data.updatedBy,
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    };
  });

  const repo = {
    findAll: vi.fn(async () => (current ? [current] : [])),
    findByKey: vi.fn(async () => current),
    findByKeyTx: vi.fn(async () => current),
    findHistory: vi.fn(async () => [] as PolicyVersion[]),
    hasVersionsTx: vi.fn(async () => hasHistory),
    appendVersionsTx: vi.fn(async (_tx: unknown, rows: PolicyVersionData[]) => {
      captured.versions = rows;
    }),
    upsertTx,
    enqueueOutbox: vi.fn(
      async (
        _tx: unknown,
        envelope: { eventType: string; payload: Record<string, unknown> },
        aggregateId: string,
      ) => {
        captured.envelope = envelope;
        captured.outboxAggregateId = aggregateId;
      },
    ),
    runInTransaction: vi.fn(async <T>(work: (tx: unknown) => Promise<T>) => work({})),
    seedMissing: vi.fn(),
  };
  return { repo, captured };
}

function policyRow(over: Partial<Policy> & Pick<Policy, 'key' | 'family'>): Policy {
  return {
    key: over.key,
    family: over.family,
    enabled: over.enabled ?? true,
    params: (over.params ?? {}) as Policy['params'],
    mandatory: over.mandatory ?? false,
    version: over.version ?? 1,
    updatedBy: over.updatedBy ?? 'system',
    updatedAt: over.updatedAt ?? new Date('2026-07-01T00:00:00.000Z'),
  };
}

describe('PoliciesService.update · CRUD del registro PBAC (ADR-024)', () => {
  it('bumpea version, persiste el estado y EMITE policy.updated por outbox (audit + cache)', async () => {
    const current = policyRow({
      key: 'auth.stepup',
      family: 'auth',
      enabled: true,
      params: { maxAgeSec: 300 },
      version: 3,
    });
    const { repo, captured } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    const out = await svc.update(
      'auth.stepup',
      { enabled: false, params: { maxAgeSec: 120 } },
      'admin-1',
    );

    // Bump de version (3 → 4), estado resuelto y actor persistidos.
    expect(captured.upsert).toMatchObject({
      key: 'auth.stepup',
      family: 'auth',
      enabled: false,
      params: { maxAgeSec: 120 },
      mandatory: false,
      version: 4,
      updatedBy: 'admin-1',
    });
    // Outbox EN LA MISMA tx: evento tipado + payload de audit/cache + aggregateId = key.
    expect(captured.outboxAggregateId).toBe('auth.stepup');
    expect(captured.envelope?.eventType).toBe('policy.updated');
    expect(captured.envelope?.payload).toMatchObject({
      key: 'auth.stepup',
      family: 'auth',
      enabled: false,
      version: 4,
      updatedBy: 'admin-1',
    });
    // Vista devuelta.
    expect(out).toMatchObject({ key: 'auth.stepup', enabled: false, version: 4 });
    expect(repo.enqueueOutbox).toHaveBeenCalledTimes(1);
  });

  it('CAS: expectedVersion desactualizado → 409 (ConcurrencyConflictError) y NO persiste (no pisa el cambio ajeno)', async () => {
    const current = policyRow({ key: 'auth.stepup', family: 'auth', version: 3 });
    const { repo, captured } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    // El admin tenía v2 a la vista pero la fila ya está en v3 (otro admin la movió) → aborta.
    await expect(
      svc.update('auth.stepup', { enabled: false, expectedVersion: 2 }, 'admin-1'),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(captured.upsert).toBeUndefined();
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
  });

  it('CAS: expectedVersion en sync (=version vigente) → aplica y bumpea normal', async () => {
    const current = policyRow({
      key: 'auth.stepup',
      family: 'auth',
      version: 3,
      params: { maxAgeSec: 300 },
    });
    const { repo, captured } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    await svc.update('auth.stepup', { enabled: false, expectedVersion: 3 }, 'admin-1');
    expect(captured.upsert).toMatchObject({ version: 4, enabled: false });
  });

  it('1er PUT: SIEMBRA el baseline (versión vigente) + la versión editada en el historial (timeline completo)', async () => {
    const current = policyRow({
      key: 'auth.stepup',
      family: 'auth',
      enabled: true,
      params: { maxAgeSec: 300 },
      version: 1,
      updatedBy: 'system',
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const { repo, captured } = makeRepo(current, false); // aún sin historial

    const svc = new PoliciesService(repo as never);
    await svc.update('auth.stepup', { params: { maxAgeSec: 120 } }, 'admin-1');

    // Dos filas: baseline (v1 · system, con el updatedAt histórico) + la edición (v2 · admin-1).
    expect(captured.versions).toEqual([
      {
        policyKey: 'auth.stepup',
        version: 1,
        enabled: true,
        params: { maxAgeSec: 300 },
        changedBy: 'system',
        changedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        policyKey: 'auth.stepup',
        version: 2,
        enabled: true,
        params: { maxAgeSec: 120 },
        changedBy: 'admin-1',
      },
    ]);
  });

  it('PUT posterior (ya hay historial): agrega SOLO la versión editada (sin re-sembrar baseline)', async () => {
    const current = policyRow({
      key: 'auth.stepup',
      family: 'auth',
      params: { maxAgeSec: 120 },
      version: 2,
    });
    const { repo, captured } = makeRepo(current, true); // YA tiene historial

    const svc = new PoliciesService(repo as never);
    await svc.update('auth.stepup', { params: { maxAgeSec: 60 } }, 'admin-2');

    expect(captured.versions).toEqual([
      {
        policyKey: 'auth.stepup',
        version: 3,
        enabled: true,
        params: { maxAgeSec: 60 },
        changedBy: 'admin-2',
      },
    ]);
  });

  it('RECHAZA params inválidos contra el schema Zod de la key (400) — sin persistir ni emitir', async () => {
    const current = policyRow({ key: 'auth.stepup', family: 'auth', params: { maxAgeSec: 300 } });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    await expect(
      svc.update('auth.stepup', { params: { maxAgeSec: -5 } }, 'admin-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(repo.upsertTx).not.toHaveBeenCalled();
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
  });

  it('RECHAZA desactivar una política mandatory (403 · Ley 29733) — sin persistir', async () => {
    const current = policyRow({
      key: 'pii.mask',
      family: 'data',
      mandatory: true,
      params: { dniTail: 4, revealRoles: ['COMPLIANCE', 'SUPERADMIN'] },
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    await expect(svc.update('pii.mask', { enabled: false }, 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(repo.upsertTx).not.toHaveBeenCalled();
  });

  it('permite editar los params de una política mandatory (el candado es solo sobre enabled)', async () => {
    const current = policyRow({
      key: 'pii.mask',
      family: 'data',
      mandatory: true,
      version: 1,
      params: { dniTail: 4, revealRoles: ['COMPLIANCE', 'SUPERADMIN'] },
    });
    const { repo, captured } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    await svc.update('pii.mask', { params: { dniTail: 2, revealRoles: ['COMPLIANCE'] } }, 'admin-1');

    expect(captured.upsert).toMatchObject({
      enabled: true, // se conserva (no vino en el parche); mandatory sigue on
      params: { dniTail: 2, revealRoles: ['COMPLIANCE'] },
      version: 2,
    });
  });

  it('RECHAZA una key desconocida (400)', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.update('nope.key', { enabled: true }, 'admin-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('crea la fila (version 1) si aún no existe, cayendo al default del catálogo (fail-safe)', async () => {
    const { repo, captured } = makeRepo(null); // sin fila previa
    const svc = new PoliciesService(repo as never);

    await svc.update('media.retention', { params: { days: 90 } }, 'admin-1');

    expect(captured.upsert).toMatchObject({
      key: 'media.retention',
      family: 'data',
      enabled: true, // defaultEnabled del catálogo
      params: { days: 90 },
      version: 1, // (0 previo) + 1
      updatedBy: 'admin-1',
    });
  });
});

describe('PoliciesService.get / list', () => {
  it('get: ValidationError si la key es desconocida', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.get('nope.key')).rejects.toBeInstanceOf(ValidationError);
  });

  it('get: NotFoundError si la key es válida pero no está seedeada', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.get('auth.stepup')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('list: proyecta las filas a la vista (params como objeto, updatedAt ISO)', async () => {
    const current = policyRow({
      key: 'auth.stepup',
      family: 'auth',
      params: { maxAgeSec: 300 },
      version: 2,
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    const out = await svc.list();
    expect(out).toEqual([
      {
        key: 'auth.stepup',
        family: 'auth',
        enabled: true,
        params: { maxAgeSec: 300 },
        mandatory: false,
        version: 2,
        updatedBy: 'system',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('PoliciesService.history · timeline del detalle', () => {
  it('ValidationError si la key es desconocida', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.history('nope.key')).rejects.toBeInstanceOf(ValidationError);
  });

  it('devuelve [] (NO lanza) si la política es válida pero aún no tiene cambios registrados', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.history('auth.stepup')).resolves.toEqual([]);
  });

  it('proyecta las filas a la vista (params objeto, changedAt ISO), más reciente primero', async () => {
    const { repo } = makeRepo(null);
    repo.findHistory.mockResolvedValueOnce([
      {
        id: 'v2',
        policyKey: 'auth.stepup',
        version: 2,
        enabled: true,
        params: { maxAgeSec: 120 } as PolicyVersion['params'],
        changedBy: 'admin-1',
        changedAt: new Date('2026-07-10T00:00:00.000Z'),
      },
      {
        id: 'v1',
        policyKey: 'auth.stepup',
        version: 1,
        enabled: true,
        params: { maxAgeSec: 300 } as PolicyVersion['params'],
        changedBy: 'system',
        changedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    const svc = new PoliciesService(repo as never);
    const out = await svc.history('auth.stepup');
    expect(out).toEqual([
      {
        version: 2,
        enabled: true,
        params: { maxAgeSec: 120 },
        changedBy: 'admin-1',
        changedAt: '2026-07-10T00:00:00.000Z',
      },
      {
        version: 1,
        enabled: true,
        params: { maxAgeSec: 300 },
        changedBy: 'system',
        changedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('PoliciesService · lectura de enforcement interno (identity se lee a sí mismo · ADR-024)', () => {
  it('getErasureGraceDays: lee el graceDays VIGENTE de la fila de privacy.erasure', async () => {
    const current = policyRow({
      key: 'privacy.erasure',
      family: 'data',
      mandatory: true,
      params: { graceDays: 7 },
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);
    await expect(svc.getErasureGraceDays()).resolves.toBe(7);
  });

  it('getPiiMaskDniTail: lee el dniTail VIGENTE de la fila de pii.mask', async () => {
    const current = policyRow({
      key: 'pii.mask',
      family: 'data',
      mandatory: true,
      params: { dniTail: 6, revealRoles: ['COMPLIANCE'] },
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);
    await expect(svc.getPiiMaskDniTail()).resolves.toBe(6);
  });

  it('fail-safe: fila NO seedeada ⇒ default del catálogo (erasure 30 · mask 4)', async () => {
    const { repo } = makeRepo(null);
    const svc = new PoliciesService(repo as never);
    await expect(svc.getErasureGraceDays()).resolves.toBe(30);
    await expect(svc.getPiiMaskDniTail()).resolves.toBe(4);
  });

  it('fail-safe: params vigentes que NO validan ⇒ default del catálogo (nunca lanza)', async () => {
    const current = policyRow({
      key: 'privacy.erasure',
      family: 'data',
      mandatory: true,
      params: { graceDays: -3 }, // viola min(0) del schema
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);
    await expect(svc.getErasureGraceDays()).resolves.toBe(30);
  });

  it('fail-safe: si el repo LANZA, cae al default del catálogo (un enforcement no se cae)', async () => {
    const { repo } = makeRepo(null);
    repo.findByKey.mockRejectedValueOnce(new Error('DB down'));
    const svc = new PoliciesService(repo as never);
    await expect(svc.getErasureGraceDays()).resolves.toBe(30);
  });

  it('cachea el param vigente (dos lecturas ⇒ una sola query) y se invalida al update()', async () => {
    const current = policyRow({
      key: 'privacy.erasure',
      family: 'data',
      mandatory: true,
      params: { graceDays: 20 },
    });
    const { repo } = makeRepo(current);
    const svc = new PoliciesService(repo as never);

    await svc.getErasureGraceDays();
    await svc.getErasureGraceDays();
    expect(repo.findByKey).toHaveBeenCalledTimes(1); // 2ª lectura sirve del cache

    // Un update de la MISMA key invalida su entrada de cache → la próxima lectura re-consulta.
    await svc.update('privacy.erasure', { params: { graceDays: 10 } }, 'admin-1');
    await svc.getErasureGraceDays();
    expect(repo.findByKey).toHaveBeenCalledTimes(2);
  });
});
