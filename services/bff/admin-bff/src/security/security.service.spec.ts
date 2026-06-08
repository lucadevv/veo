import { describe, it, expect, vi } from 'vitest';
import { SecurityService } from './security.service';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';

const identity: AuthenticatedUser = { userId: 'sec1', type: 'admin', roles: ['SUPPORT_L2'], sessionId: 's1' };

const panicEntity = {
  id: 'pa1',
  tripId: 't1',
  passengerId: 'p1',
  triggeredAt: '2026-05-29T00:00:00.000Z',
  geoPoint: { lat: -12.05, lon: -77.04 },
  dedupKey: 'k1',
  status: 'TRIGGERED',
  evidenceS3Keys: ['s3://a'],
};

describe('SecurityService', () => {
  it('mapea PanicEntity → panicSummary (geoPoint → geo, acknowledgedAt nullable)', async () => {
    const rest = { get: vi.fn().mockResolvedValue([panicEntity]) } as unknown as InternalRestClient;
    const audit = { record: vi.fn() } as unknown as AuditRecorder;
    const svc = new SecurityService(rest, audit);
    const list = await svc.listPanics(identity, {});
    expect(list[0]).toEqual({
      id: 'pa1',
      tripId: 't1',
      passengerId: 'p1',
      status: 'TRIGGERED',
      geo: { lat: -12.05, lon: -77.04 },
      triggeredAt: '2026-05-29T00:00:00.000Z',
      acknowledgedAt: null,
    });
  });

  it('ack registra auditoría', async () => {
    const rest = { post: vi.fn().mockResolvedValue({ ...panicEntity, status: 'ACKNOWLEDGED', acknowledgedAt: 'x', ackBy: 'sec1' }) } as unknown as InternalRestClient;
    const audit = { record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }) } as unknown as AuditRecorder;
    const svc = new SecurityService(rest, audit);
    const out = await svc.ack(identity, 'pa1');
    expect(out.status).toBe('ACKNOWLEDGED');
    expect(out.ackBy).toBe('sec1');
    expect(audit.record).toHaveBeenCalledOnce();
  });
});
