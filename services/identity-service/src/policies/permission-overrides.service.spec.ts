import { describe, it, expect, vi } from 'vitest';
import { ConcurrencyConflictError, ForbiddenError, ValidationError } from '@veo/utils';
import { PermissionOverridesService } from './permission-overrides.service';
import type { UpsertPermissionOverrideData } from './permission-overrides.repository';
import type { PermissionOverride } from '../generated/prisma';

/**
 * Doble de PermissionOverridesRepository: `runInTransaction` ejecuta el work con un tx ficticio; `findByPairTx`
 * devuelve el estado "actual"; `upsertTx` echoa la data como haría la DB; `enqueueOutbox` captura el envelope.
 * Así el spec verifica la LÓGICA del service (invariante subtract-only, candado legal, bump, outbox) sin Prisma.
 */
function makeRepo(current: PermissionOverride | null) {
  const captured: {
    upsert?: UpsertPermissionOverrideData;
    envelope?: { eventType: string; payload: Record<string, unknown> };
    outboxAggregateId?: string;
  } = {};

  const upsertTx = vi.fn(
    async (_tx: unknown, data: UpsertPermissionOverrideData): Promise<PermissionOverride> => {
      captured.upsert = data;
      return {
        role: data.role,
        permission: data.permission,
        hidden: data.hidden,
        version: data.version,
        updatedBy: data.updatedBy,
        updatedAt: new Date('2026-07-10T00:00:00.000Z'),
      };
    },
  );

  const repo = {
    findAll: vi.fn(async () => (current ? [current] : [])),
    findByPair: vi.fn(async () => current),
    findByPairTx: vi.fn(async () => current),
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
  };
  return { repo, captured };
}

function overrideRow(over: Partial<PermissionOverride> & Pick<PermissionOverride, 'role' | 'permission'>): PermissionOverride {
  return {
    role: over.role,
    permission: over.permission,
    hidden: over.hidden ?? true,
    version: over.version ?? 1,
    updatedBy: over.updatedBy ?? 'admin-1',
    updatedAt: over.updatedAt ?? new Date('2026-07-01T00:00:00.000Z'),
  };
}

describe('PermissionOverridesService.set · overlay subtract-only (ADR-025 §3)', () => {
  it('par base-válido: bumpea version, persiste y EMITE permission_override.updated por outbox (audit + cache)', async () => {
    // base: 'drivers:approve' → [COMPLIANCE_SUPERVISOR, ADMIN, SUPERADMIN]. ADMIN lo concede → se puede RESTAR.
    const current = overrideRow({ role: 'ADMIN', permission: 'drivers:approve', version: 2 });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    const out = await svc.set('ADMIN', 'drivers:approve', true, 'super-1');

    // Bump de version (2 → 3), estado resuelto y actor persistidos.
    expect(captured.upsert).toMatchObject({
      role: 'ADMIN',
      permission: 'drivers:approve',
      hidden: true,
      version: 3,
      updatedBy: 'super-1',
    });
    // Outbox EN LA MISMA tx: evento tipado + payload de audit/cache + aggregateId = `role|permission`.
    expect(captured.outboxAggregateId).toBe('ADMIN|drivers:approve');
    expect(captured.envelope?.eventType).toBe('permission_override.updated');
    expect(captured.envelope?.payload).toMatchObject({
      role: 'ADMIN',
      permission: 'drivers:approve',
      hidden: true,
      version: 3,
      updatedBy: 'super-1',
    });
    expect(out).toMatchObject({ role: 'ADMIN', permission: 'drivers:approve', hidden: true, version: 3 });
    expect(repo.enqueueOutbox).toHaveBeenCalledTimes(1);
  });

  it('CAS: expectedVersion desactualizado → 409 (ConcurrencyConflictError) y NO persiste (no pisa el ajeno)', async () => {
    const current = overrideRow({ role: 'ADMIN', permission: 'drivers:approve', version: 2 });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    // El superadmin tenía v1 a la vista pero el par ya está en v2 (otro lo movió) → aborta.
    await expect(
      svc.set('ADMIN', 'drivers:approve', true, 'super-1', 1),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(captured.upsert).toBeUndefined();
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
  });

  it('CAS: expectedVersion en sync (=version vigente) → aplica y bumpea normal', async () => {
    const current = overrideRow({ role: 'ADMIN', permission: 'drivers:approve', version: 2 });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    await svc.set('ADMIN', 'drivers:approve', true, 'super-1', 2);
    expect(captured.upsert).toMatchObject({ version: 3, hidden: true });
  });

  it('CAS: sin expectedVersion (1ª resta / compat) → aplica sin chequear (no rompe el create)', async () => {
    const { repo, captured } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);
    await svc.set('COMPLIANCE_SUPERVISOR', 'fleet:review', true, 'super-1');
    expect(captured.upsert).toMatchObject({ version: 1 });
  });

  it('crea la fila (version 1) si el par aún no tiene override (fail-safe)', async () => {
    const { repo, captured } = makeRepo(null); // sin fila previa
    const svc = new PermissionOverridesService(repo as never);

    await svc.set('COMPLIANCE_SUPERVISOR', 'fleet:review', true, 'super-1');

    expect(captured.upsert).toMatchObject({
      role: 'COMPLIANCE_SUPERVISOR',
      permission: 'fleet:review',
      hidden: true,
      version: 1, // (0 previo) + 1
      updatedBy: 'super-1',
    });
  });

  it('RECHAZA (400) un par que la BASE NO concede — subtract-only, no se puede conceder de más', async () => {
    // base: 'drivers:approve' NO incluye a SUPPORT_L1 → "restarlo" sería conceder encubierto.
    const { repo } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);

    await expect(svc.set('SUPPORT_L1', 'drivers:approve', true, 'super-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repo.upsertTx).not.toHaveBeenCalled();
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
  });

  it('RECHAZA (403 · Ley 29733) restar un permiso legal-mandatory (finance:payout de FINANCE)', async () => {
    // base: 'finance:payout' → [FINANCE] (válido), PERO es legal-mandatory → no restable-off.
    const { repo } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);

    await expect(svc.set('FINANCE', 'finance:payout', true, 'super-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(repo.upsertTx).not.toHaveBeenCalled();
  });

  it('RECHAZA (403) restar audit:view a COMPLIANCE (separación de funciones)', async () => {
    const { repo } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);
    await expect(
      svc.set('COMPLIANCE_SUPERVISOR', 'audit:view', true, 'super-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hidden=false DES-RESTAURA un par base-válido (rige la base) y persiste con bump', async () => {
    const current = overrideRow({ role: 'ADMIN', permission: 'drivers:approve', hidden: true, version: 4 });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    const out = await svc.set('ADMIN', 'drivers:approve', false, 'super-1');

    expect(captured.upsert).toMatchObject({ hidden: false, version: 5 });
    expect(out.hidden).toBe(false);
    // des-restaurar un legal-mandatory NO debería ni siquiera existir, pero hidden=false es inocuo:
    // el candado legal solo bloquea la RESTA (hidden=true), no el des-restaurado.
  });

  it('des-restaurar (hidden=false) un permiso legal-mandatory base-válido NO se bloquea (inocuo)', async () => {
    const current = overrideRow({ role: 'FINANCE', permission: 'finance:payout', hidden: true });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    await svc.set('FINANCE', 'finance:payout', false, 'super-1');
    expect(captured.upsert).toMatchObject({ hidden: false });
  });

  it('idempotencia: re-setear el MISMO par upserta la misma fila y vuelve a bumpear version (sin duplicar)', async () => {
    const current = overrideRow({ role: 'ADMIN', permission: 'drivers:approve', hidden: true, version: 7 });
    const { repo, captured } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    await svc.set('ADMIN', 'drivers:approve', true, 'super-1');
    expect(captured.upsert).toMatchObject({ role: 'ADMIN', permission: 'drivers:approve', version: 8 });
    // upsert por clave compuesta = una sola fila garantizada (no hay INSERT duplicado).
    expect(repo.upsertTx).toHaveBeenCalledTimes(1);
  });

  it('RECHAZA (400) un rol desconocido', async () => {
    const { repo } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);
    await expect(svc.set('WIZARD', 'drivers:approve', true, 'super-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('RECHAZA (400) un permiso desconocido', async () => {
    const { repo } = makeRepo(null);
    const svc = new PermissionOverridesService(repo as never);
    await expect(svc.set('ADMIN', 'nope:nope', true, 'super-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('PermissionOverridesService.list', () => {
  it('proyecta las filas a la vista (updatedAt ISO)', async () => {
    const current = overrideRow({
      role: 'ADMIN',
      permission: 'drivers:approve',
      hidden: true,
      version: 2,
    });
    const { repo } = makeRepo(current);
    const svc = new PermissionOverridesService(repo as never);

    const out = await svc.list();
    expect(out).toEqual([
      {
        role: 'ADMIN',
        permission: 'drivers:approve',
        hidden: true,
        version: 2,
        updatedBy: 'admin-1',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });
});
