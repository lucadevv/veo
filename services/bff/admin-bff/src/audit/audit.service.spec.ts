import { describe, it, expect, vi } from 'vitest';
import { AuditService, toAuditEntryView } from './audit.service';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';

const identity: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: ['ADMIN'],
  sessionId: 's1',
};

function entry(seq: string) {
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

describe('toAuditEntryView', () => {
  it('mapea occurredAt → at y actorId nullable', () => {
    expect(toAuditEntryView({ ...entry('10'), actorId: null })).toEqual({
      id: 'id-10',
      seq: '10',
      actorId: null,
      action: 'driver.approve',
      resourceType: 'driver',
      resourceId: 'd1',
      at: '2026-05-29T00:00:00.000Z',
    });
  });
});

describe('AuditService.list (cursor beforeSeq)', () => {
  it('devuelve nextCursor cuando la página está llena', async () => {
    const rest = { get: vi.fn().mockResolvedValue([entry('10'), entry('9')]) };
    const svc = new AuditService(rest as unknown as InternalRestClient);
    const out = await svc.list(identity, { limit: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe('9');
  });

  it('nextCursor null cuando la página no se llena', async () => {
    const rest = { get: vi.fn().mockResolvedValue([entry('10')]) };
    const svc = new AuditService(rest as unknown as InternalRestClient);
    const out = await svc.list(identity, { limit: 2 });
    expect(out.nextCursor).toBeNull();
  });
});
