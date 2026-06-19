import { describe, it, expect, vi } from 'vitest';
import { MediaService, type SegmentView } from './media.service';
import type { InternalRestClient, GrpcServiceClient } from '@veo/rpc';
import type { ConfigService } from '@nestjs/config';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';

const identity: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: ['ADMIN'],
  sessionId: 's1',
};

/** Construye el servicio con los 4 colaboradores mockeados (rest, tripGrpc, audit, config). */
function makeService(
  over: {
    rest?: Partial<InternalRestClient>;
    tripGrpc?: { call: ReturnType<typeof vi.fn> };
    audit?: { record: ReturnType<typeof vi.fn> };
  } = {},
) {
  const rest = over.rest ?? { get: vi.fn(), post: vi.fn() };
  const tripGrpc = over.tripGrpc ?? { call: vi.fn() };
  const audit = over.audit ?? {
    record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }),
  };
  const config = { get: () => 'internal-secret' } as unknown as ConfigService<Env, true>;
  const svc = new MediaService(
    rest as unknown as InternalRestClient,
    tripGrpc as unknown as GrpcServiceClient,
    InternalAudience.ADMIN_RAIL,
    audit as unknown as AuditRecorder,
    config,
  );
  return { svc, rest, tripGrpc, audit };
}

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
    const segs = [segment('s1', { hasPanic: true }), segment('s2', { hasIncident: true })];
    const { svc, audit } = makeService({ rest: { get: vi.fn().mockResolvedValue(segs) } });

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
    const { svc, audit } = makeService({ rest: { get: vi.fn().mockResolvedValue([]) } });

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
    const { svc } = makeService({
      rest: { get: vi.fn().mockResolvedValue([segment('s1')]) },
      audit: { record: vi.fn().mockRejectedValue(new Error('audit down')) },
    });

    await expect(svc.segments(identity, 't1')).rejects.toThrow('audit down');
  });
});

describe('MediaService.issueLiveToken · cámara EN VIVO (doble-auth + gate de estado)', () => {
  const liveDto = { tripId: 't1', reason: 'verificación de incidente reportado por el pasajero' };

  it('autoriza, audita y mintea cuando el viaje está IN_PROGRESS', async () => {
    const grant = { roomName: 'trip-t1', token: 'jwt', url: 'ws://lk', expiresInSeconds: 3600 };
    const { svc, rest, tripGrpc, audit } = makeService({
      tripGrpc: { call: vi.fn().mockResolvedValue({ status: 'IN_PROGRESS', found: true }) },
      rest: { post: vi.fn().mockResolvedValue(grant) },
    });

    const out = await svc.issueLiveToken(identity, liveDto);

    expect(out).toBe(grant);
    expect(tripGrpc.call).toHaveBeenCalledWith('GetTrip', { id: 't1' }, expect.any(Object));
    expect(audit.record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'media.live_access', resourceId: 't1' }),
    );
    // La identidad del operador en la room la deriva el bff, no el cliente.
    expect(rest.post).toHaveBeenCalledWith('/media/rooms/t1/viewer-token', {
      identity,
      body: { name: 'admin-u1' },
    });
  });

  it('RECHAZA (403) si el viaje NO está en curso — sin auditar ni mintear', async () => {
    const { svc, rest, audit } = makeService({
      tripGrpc: { call: vi.fn().mockResolvedValue({ status: 'COMPLETED', found: true }) },
      rest: { post: vi.fn() },
    });

    await expect(svc.issueLiveToken(identity, liveDto)).rejects.toThrow(/viaje en curso/i);
    expect(audit.record).not.toHaveBeenCalled(); // no se registra un acceso que no ocurrió
    expect(rest.post).not.toHaveBeenCalled(); // no se mintea token
  });

  it('RECHAZA (404) si el viaje no existe — sin mintear', async () => {
    const { svc, rest } = makeService({
      tripGrpc: { call: vi.fn().mockResolvedValue({ status: '', found: false }) },
      rest: { post: vi.fn() },
    });

    await expect(svc.issueLiveToken(identity, liveDto)).rejects.toThrow(/no encontrado/i);
    expect(rest.post).not.toHaveBeenCalled();
  });

  it('fail-closed: si el audit falla, NO se mintea el token', async () => {
    const { svc, rest } = makeService({
      tripGrpc: { call: vi.fn().mockResolvedValue({ status: 'IN_PROGRESS', found: true }) },
      rest: { post: vi.fn() },
      audit: { record: vi.fn().mockRejectedValue(new Error('audit down')) },
    });

    await expect(svc.issueLiveToken(identity, liveDto)).rejects.toThrow('audit down');
    expect(rest.post).not.toHaveBeenCalled();
  });
});
