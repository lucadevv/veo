import { describe, it, expect, vi } from 'vitest';
import { MediaService, type SegmentView } from './media.service';
import type { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';

const identity: AuthenticatedUser = { userId: 'u1', type: 'admin', roles: ['ADMIN'], sessionId: 's1' };

function segment(id: string, partial: Partial<SegmentView> = {}): SegmentView {
  return {
    id,
    tripId: 't1',
    startedAt: '2026-06-04T10:00:00.000Z',
    endedAt: '2026-06-04T10:05:00.000Z',
    sizeBytes: 1000,
    codec: 'h264',
    retentionUntil: null,
    accessedCount: 0,
    hasPanic: false,
    hasIncident: false,
    ...partial,
  };
}

describe('MediaService.segments · auditoría de listado (Ley 29733)', () => {
  it('registra un audit del listado con count y flags hasPanic/hasIncident', async () => {
    const segs = [
      segment('s1', { hasPanic: true }),
      segment('s2', { hasIncident: true }),
    ];
    const rest = { get: vi.fn().mockResolvedValue(segs) };
    const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
    const svc = new MediaService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    const out = await svc.segments(identity, 't1');

    expect(out).toBe(segs);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(identity, {
      action: 'media.segments_list',
      resourceType: 'media_segments',
      resourceId: 't1',
      payload: { tripId: 't1', segmentCount: 2, hasPanic: true, hasIncident: true },
    });
  });

  it('audita también un listado vacío (flags en false, count 0)', async () => {
    const rest = { get: vi.fn().mockResolvedValue([]) };
    const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
    const svc = new MediaService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    await svc.segments(identity, 't1');

    expect(audit.record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        action: 'media.segments_list',
        payload: { tripId: 't1', segmentCount: 0, hasPanic: false, hasIncident: false },
      }),
    );
  });

  it('fail-closed: si el audit falla, segments() falla (no devuelve la lista)', async () => {
    const rest = { get: vi.fn().mockResolvedValue([segment('s1')]) };
    const audit = { record: vi.fn().mockRejectedValue(new Error('audit down')) };
    const svc = new MediaService(rest as unknown as InternalRestClient, audit as unknown as AuditRecorder);

    await expect(svc.segments(identity, 't1')).rejects.toThrow('audit down');
  });
});
