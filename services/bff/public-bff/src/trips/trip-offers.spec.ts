/**
 * Test de la PUJA · lado pasajero (TripsService.listOffers/acceptOffer/cancelBid):
 * ownership anti-IDOR (mismo gate que tip/video) + delegación firmada a dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { TripsService } from './trips.service';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { LiveKitConfig } from '../share/livekit-token';

const SECRET = 'dev-internal-secret-change-me';
const livekit: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function makeService(trip: { found: boolean; passengerId: string }, dispatchResult: unknown = []) {
  const tripGrpc = {
    call: vi.fn().mockResolvedValue({ ...trip, status: 'REQUESTED' }),
  } as unknown as GrpcServiceClient;
  const get = vi.fn().mockResolvedValue(dispatchResult);
  const post = vi.fn().mockResolvedValue(dispatchResult);
  const dispatchRest = { get, post } as unknown as InternalRestClient;
  // REST de trip-service: el rebid se reenvía aquí (no a dispatch). Capturamos sus llamadas aparte.
  const tripPost = vi.fn().mockResolvedValue(dispatchResult);
  const tripRest = { post: tripPost } as unknown as InternalRestClient;
  const stub = {} as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  // BE-1 · enrichment fijo para verificar que listOffers fusiona rating+vehículo sobre cada oferta.
  const enrich = vi.fn().mockResolvedValue({
    driverName: 'Khalid Ríos',
    rating: 4.9,
    ratingCount: 12,
    vehicle: { make: 'Toyota', model: 'Yaris', color: 'Plomo', plate: 'ABC-123' },
  });
  const enrichment = { enrich } as unknown as DriverEnrichmentService;
  const svc = new TripsService(
    tripGrpc,
    stub,
    stub,
    stub,
    stub,
    tripRest,
    dispatchRest,
    restStub,
    restStub, // ratingRest (REST_RATING) — MI rating del enrich, no usado en listOffers
    livekit,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    { get: async () => null, set: async () => 'OK' } as never, // REDIS (cache KYC, no usado acá)
    enrichment,
  );
  return { svc, get, post, tripPost, enrich };
}

describe('TripsService — PUJA lado pasajero (ownership + delegación)', () => {
  it('listOffers delega a dispatch GET /bids/:tripId/offers y devuelve { board, offers } enriquecidas', async () => {
    // FIX contrato: dispatch ahora responde { board:{status,expiresAt}, offers } (no un array pelado).
    const offer = {
      tripId: 'trip-1',
      driverId: 'd1',
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
      etaSeconds: 120,
      status: 'PENDING',
    };
    const dispatchView = {
      board: { status: 'OPEN', expiresAt: 1_900_000_000_000 },
      offers: [offer],
    };
    const { svc, get, enrich } = makeService({ found: true, passengerId: 'usr-1' }, dispatchView);
    const res = await svc.listOffers(user, 'trip-1');
    // El board se pasa tal cual; cada oferta queda ENRIQUECIDA con rating + vehículo (BE-1).
    expect(res.board).toEqual({ status: 'OPEN', expiresAt: 1_900_000_000_000 });
    expect(res.offers).toHaveLength(1);
    expect(res.offers[0]).toMatchObject({
      ...offer,
      driverName: 'Khalid Ríos',
      rating: 4.9,
      ratingCount: 12,
      vehicle: { make: 'Toyota', model: 'Yaris', color: 'Plomo', plate: 'ABC-123' },
    });
    expect(enrich).toHaveBeenCalledWith('d1', expect.anything());
    expect(get).toHaveBeenCalledWith(
      '/bids/trip-1/offers',
      expect.objectContaining({ identity: user }),
    );
  });

  it('listOffers rechaza con 403 si el viaje no pertenece al pasajero (anti-IDOR)', async () => {
    const { svc, get } = makeService({ found: true, passengerId: 'otro' });
    await expect(svc.listOffers(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 403 });
    expect(get).not.toHaveBeenCalled();
  });

  it('listOffers responde 404 si el viaje no existe', async () => {
    const { svc } = makeService({ found: false, passengerId: 'usr-1' });
    await expect(svc.listOffers(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('acceptOffer delega a dispatch con idempotencyKey por (passenger,trip,driver)', async () => {
    const accepted = {
      tripId: 'trip-1',
      driverId: 'd1',
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
      etaSeconds: 120,
      status: 'ACCEPTED',
    };
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1' }, accepted);
    const res = await svc.acceptOffer(user, 'trip-1', 'd1');
    expect(res).toEqual(accepted);
    expect(post).toHaveBeenCalledWith(
      '/bids/trip-1/accept',
      expect.objectContaining({
        idempotencyKey: 'accept_offer:usr-1:trip-1:d1',
        body: { driverId: 'd1' },
      }),
    );
  });

  it('acceptOffer rechaza con 403 sobre un viaje ajeno (no llama a dispatch)', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'otro' });
    await expect(svc.acceptOffer(user, 'trip-1', 'd1')).rejects.toMatchObject({ httpStatus: 403 });
    expect(post).not.toHaveBeenCalled();
  });

  it('cancelBid delega a dispatch POST /bids/:tripId/cancel para el viaje propio', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1' }, { ok: true });
    const res = await svc.cancelBid(user, 'trip-1');
    expect(res).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith(
      '/bids/trip-1/cancel',
      expect.objectContaining({ identity: user }),
    );
  });

  it('cancelBid rechaza con 403 sobre un viaje ajeno', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'otro' });
    await expect(svc.cancelBid(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 403 });
    expect(post).not.toHaveBeenCalled();
  });

  // ── RE-PUJA (H6.4): ownership + delegación a trip-service (NO a dispatch) ──

  it('rebid delega a trip-service POST /trips/:id/rebid con passengerId de la identidad e idempotencyKey', async () => {
    const reactivated = {
      id: 'trip-1',
      passengerId: 'usr-1',
      status: 'REQUESTED',
      fareCents: 1500,
    };
    const { svc, tripPost } = makeService({ found: true, passengerId: 'usr-1' }, reactivated);
    const res = await svc.rebid(user, 'trip-1', { bidCents: 1500 });
    expect(res).toEqual(reactivated);
    expect(tripPost).toHaveBeenCalledWith(
      '/trips/trip-1/rebid',
      expect.objectContaining({
        identity: user,
        idempotencyKey: 'rebid:usr-1:trip-1:1500',
        body: { passengerId: 'usr-1', bidCents: 1500 },
      }),
    );
  });

  it('rebid rechaza con 403 sobre un viaje ajeno (anti-IDOR, no llama a trip-service)', async () => {
    const { svc, tripPost } = makeService({ found: true, passengerId: 'otro' });
    await expect(svc.rebid(user, 'trip-1', { bidCents: 1500 })).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(tripPost).not.toHaveBeenCalled();
  });

  it('rebid responde 404 si el viaje no existe', async () => {
    const { svc, tripPost } = makeService({ found: false, passengerId: 'usr-1' });
    await expect(svc.rebid(user, 'trip-1', { bidCents: 1500 })).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(tripPost).not.toHaveBeenCalled();
  });
});
