/** Test de la autorización del token de video del habitáculo para el pasajero (TripsService.videoGrant). */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { TripsService } from './trips.service';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { LiveKitConfig } from '../share/livekit-token';

const SECRET = 'dev-internal-secret-change-me';
const enabled: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function makeService(opts: {
  livekit?: LiveKitConfig;
  trip?: { found: boolean; passengerId: string; status: string };
}) {
  const tripGrpc = {
    call: vi.fn().mockResolvedValue(
      opts.trip ?? { found: true, passengerId: 'usr-1', status: 'IN_PROGRESS' },
    ),
  } as unknown as GrpcServiceClient;
  const stub = {} as unknown as GrpcServiceClient;
  const rest = {} as unknown as InternalRestClient;
  return new TripsService(
    tripGrpc,
    stub,
    stub,
    stub,
    stub,
    rest,
    rest,
    rest,
    rest, // ratingRest (REST_RATING) — MI rating del enrich, no usado en videoGrant
    opts.livekit ?? enabled,
    SECRET,
    { get: async () => null, set: async () => 'OK' } as never, // REDIS (cache KYC, no usado acá)
    {} as unknown as DriverEnrichmentService,
  );
}

describe('TripsService.videoGrant', () => {
  it('emite un token viewer LiveKit para el viaje en curso del propio pasajero', async () => {
    const svc = makeService({});
    const grant = await svc.videoGrant(user, 'trip-1');
    expect(grant.url).toBe(enabled.url);
    expect(grant.roomName).toBe('trip:trip-1');
    expect(grant.token.split('.')).toHaveLength(3);
  });

  it('responde 404 (NotFound) si LiveKit no está configurado', async () => {
    const svc = makeService({ livekit: { ...enabled, apiKey: '', apiSecret: '' } });
    await expect(svc.videoGrant(user, 'trip-1')).rejects.toMatchObject({ status: 404 });
  });

  it('rechaza si el viaje no pertenece al pasajero', async () => {
    const svc = makeService({ trip: { found: true, passengerId: 'otro', status: 'IN_PROGRESS' } });
    await expect(svc.videoGrant(user, 'trip-1')).rejects.toMatchObject({ status: 403 });
  });

  it('rechaza si el viaje no está IN_PROGRESS', async () => {
    const svc = makeService({ trip: { found: true, passengerId: 'usr-1', status: 'ARRIVED' } });
    await expect(svc.videoGrant(user, 'trip-1')).rejects.toMatchObject({ status: 403 });
  });
});
