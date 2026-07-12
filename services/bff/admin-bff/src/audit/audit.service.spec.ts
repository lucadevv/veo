import { describe, it, expect, vi } from 'vitest';
import { AuditService, toAuditEntryView } from './audit.service';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from './audit-recorder.service';

const identity: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: ['COMPLIANCE_SUPERVISOR'],
  sessionId: 's1',
};

interface EntryShape {
  id: string;
  seq: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
}
function entry(seq: string, over: Partial<EntryShape> = {}): EntryShape {
  return { ...baseEntry(seq), ...over };
}
function baseEntry(seq: string): EntryShape {
  return {
    id: `id-${seq}`,
    seq,
    actorId: 'actor',
    action: 'driver.approve',
    resourceType: 'driver',
    resourceId: 'd1',
    occurredAt: '2026-05-29T00:00:00.000Z',
  };
}

/**
 * Construye el service con mocks. `restGet` responde tanto a `/audit`/`/audit/export`; `opsRows` es el roster de
 * operadores que devuelve identity `/admin/operators`; `record` captura las auditorías del export.
 */
function makeSvc(opts: {
  restGet: ReturnType<typeof vi.fn>;
  opsRows?: unknown;
  record?: ReturnType<typeof vi.fn>;
}) {
  const rest = { get: opts.restGet } as unknown as InternalRestClient;
  const identityRest = {
    get: vi.fn().mockResolvedValue(opts.opsRows ?? []),
  } as unknown as InternalRestClient;
  const audit = {
    record: opts.record ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditRecorder;
  return { svc: new AuditService(rest, identityRest, audit), identityRest, audit };
}

describe('toAuditEntryView', () => {
  it('mapea occurredAt → at, actorId nullable y actorName/actorRole null sin enrich', () => {
    expect(toAuditEntryView({ ...baseEntry('10'), actorId: null })).toEqual({
      id: 'id-10',
      seq: '10',
      actorId: null,
      actorName: null,
      actorRole: null,
      action: 'driver.approve',
      resourceType: 'driver',
      resourceId: 'd1',
      at: '2026-05-29T00:00:00.000Z',
    });
  });

  it('inyecta actorName/actorRole del actor resuelto', () => {
    const view = toAuditEntryView(baseEntry('10'), { name: 'Ana Paredes', role: 'COMPLIANCE_SUPERVISOR' });
    expect(view.actorName).toBe('Ana Paredes');
    expect(view.actorRole).toBe('COMPLIANCE_SUPERVISOR');
  });
});

describe('AuditService.list (cursor + filtros)', () => {
  it('devuelve nextCursor cuando la página está llena', async () => {
    const restGet = vi.fn().mockResolvedValue([entry('10'), entry('9')]);
    const { svc } = makeSvc({ restGet });
    const out = await svc.list(identity, { limit: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe('9');
  });

  it('nextCursor null cuando la página no se llena', async () => {
    const restGet = vi.fn().mockResolvedValue([entry('10')]);
    const { svc } = makeSvc({ restGet });
    const out = await svc.list(identity, { limit: 2 });
    expect(out.nextCursor).toBeNull();
  });

  it('propaga los filtros estructurados y mapea cursor→beforeSeq', async () => {
    const restGet = vi.fn().mockResolvedValue([]);
    const { svc } = makeSvc({ restGet });
    await svc.list(identity, {
      q: 'DR-11',
      category: 'driver',
      from: '2026-05-01',
      to: '2026-05-31',
      cursor: '42',
    });
    const [, opts] = restGet.mock.calls[0]!;
    expect(opts.query).toMatchObject({
      q: 'DR-11',
      category: 'driver',
      from: '2026-05-01',
      to: '2026-05-31',
      beforeSeq: '42',
    });
  });

  it('enriquece el actor con nombre + rol del roster de operadores', async () => {
    const restGet = vi.fn().mockResolvedValue([entry('10', { actorId: 'op-1' })]);
    const { svc, identityRest } = makeSvc({
      restGet,
      opsRows: [{ id: 'op-1', name: 'Ana Paredes', roles: ['COMPLIANCE_SUPERVISOR'] }],
    });
    const out = await svc.list(identity, { limit: 50 });
    expect(identityRest.get).toHaveBeenCalledWith('/admin/operators', expect.anything());
    expect(out.items[0]).toMatchObject({
      actorName: 'Ana Paredes',
      actorRole: 'COMPLIANCE_SUPERVISOR',
    });
  });

  it('degrada honesto a null si el actor no está en el roster', async () => {
    const restGet = vi.fn().mockResolvedValue([entry('10', { actorId: 'unknown' })]);
    const { svc } = makeSvc({ restGet, opsRows: [{ id: 'op-1', name: 'Ana', roles: ['ADMIN'] }] });
    const out = await svc.list(identity, { limit: 50 });
    expect(out.items[0]!.actorName).toBeNull();
    expect(out.items[0]!.actorRole).toBeNull();
  });

  it('no consulta el roster si ninguna entrada tiene actorId (evita round-trip inútil)', async () => {
    const restGet = vi.fn().mockResolvedValue([entry('10', { actorId: null })]);
    const { svc, identityRest } = makeSvc({ restGet });
    await svc.list(identity, { limit: 50 });
    expect(identityRest.get).not.toHaveBeenCalled();
  });
});

describe('AuditService.exportAudit', () => {
  it('exporta el filtro server-side, arma CSV enriquecido y AUDITA la exportación', async () => {
    const restGet = vi.fn().mockResolvedValue([
      entry('11', { actorId: 'op-1', action: 'driver.suspended', resourceId: 'dr-771' }),
      entry('10', { actorId: 'sys', action: 'trip.completed' }),
    ]);
    const record = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      restGet,
      opsRows: [{ id: 'op-1', name: 'Luis Carranza', roles: ['SUPERADMIN'] }],
      record,
    });

    const csv = await svc.exportAudit(identity, { category: 'driver', from: '2026-05-01' });

    // El export golpea la ruta server-side con SOLO los filtros (sin cursor/limit).
    const [path, opts] = restGet.mock.calls[0]!;
    expect(path).toBe('/audit/export');
    expect(opts.query).toMatchObject({ category: 'driver', from: '2026-05-01' });

    // CSV: header + una fila por entrada; el actor resuelto lleva nombre+rol, el no-staff queda vacío.
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('seq,fecha,accion,recursoTipo,recursoId,actorId,actorNombre,actorRol');
    expect(lines[1]!).toContain('driver.suspended');
    expect(lines[1]!).toContain('Luis Carranza');
    expect(lines[1]!).toContain('SUPERADMIN');
    expect(lines[2]!).toContain('trip.completed');

    // La exportación se AUDITA (accountability de acceso al libro de compliance).
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'audit.export', resourceType: 'audit_log', resourceId: 'driver' }),
    );
  });

  it('escapa campos CSV con comas/comillas (RFC 4180)', async () => {
    const restGet = vi
      .fn()
      .mockResolvedValue([entry('10', { actorId: null, resourceId: 'a,b"c' })]);
    const { svc } = makeSvc({ restGet });
    const csv = await svc.exportAudit(identity, {});
    expect(csv).toContain('"a,b""c"');
  });
});
