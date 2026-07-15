/** Test de la propina del pasajero a su viaje (TripsService.tip): ownership + delegación firmada. */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { TripsService } from './trips.service';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { LiveKitConfig } from '../share/livekit-token';

const SECRET = 'dev-internal-secret-change-me';
const livekit: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function makeService(trip: { found: boolean; passengerId: string }) {
  const tripGrpc = {
    call: vi.fn().mockResolvedValue({ ...trip, status: 'COMPLETED' }),
  } as unknown as GrpcServiceClient;
  const post = vi.fn().mockResolvedValue({
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'YAPE',
    status: 'CAPTURED',
    amountCents: 2300,
    grossCents: 2000,
    tipCents: 300,
    commissionCents: 400,
    feeCents: 400,
    externalRef: null,
  });
  const paymentRest = { post } as unknown as InternalRestClient;
  const stub = {} as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  const svc = new TripsService(
    tripGrpc,
    stub,
    stub,
    stub,
    stub,
    restStub,
    restStub,
    paymentRest,
    restStub, // ratingRest (REST_RATING) — MI rating del enrich, no usado en tip
    livekit,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    { get: async () => null, set: async () => 'OK' } as never, // REDIS (cache KYC, no usado acá)
    { routeWithSteps: async () => ({ polyline: '', distanceMeters: 0, durationSeconds: 0, steps: [] }) } as never, // MAPS (@veo/maps) — no ejercitado acá
    {} as unknown as DriverEnrichmentService,
    {} as unknown as DispatchService,
    { getLocation: () => undefined } as never, // RealtimeStateService — no ejercitado acá
  );
  return { svc, post };
}

describe('TripsService.tip', () => {
  it('verifica ownership y delega a payment con dedupKey idempotente', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1' });
    const view = await svc.tip(user, 'trip-1', 300);
    expect(view.tipCents).toBe(300);
    expect(view.amountCents).toBe(2300);
    expect(view.externalRef).toBe('');
    expect(post).toHaveBeenCalledWith(
      '/payments/trip-1/tip',
      expect.objectContaining({
        idempotencyKey: 'tip:usr-1:trip-1:300',
        body: { tipCents: 300, dedupKey: 'tip:usr-1:trip-1:300' },
      }),
    );
  });

  it('rechaza si el viaje no pertenece al pasajero', async () => {
    const { svc } = makeService({ found: true, passengerId: 'otro' });
    await expect(svc.tip(user, 'trip-1', 300)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('404 si el viaje no existe', async () => {
    const { svc } = makeService({ found: false, passengerId: 'usr-1' });
    await expect(svc.tip(user, 'trip-1', 300)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
