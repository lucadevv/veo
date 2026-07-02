/**
 * Re-entrada del cierre post-viaje en el BFF (TripsService.getPendingSettlement / close):
 * delegación gRPC + gate anti-IDOR en close. Dobles sin Nest DI, al estilo de trip-tip.spec.ts.
 */
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

const TRIP_REPLY = {
  found: true,
  id: 'trip-1',
  passengerId: 'usr-1',
  driverId: '',
  vehicleId: '',
  status: 'COMPLETED',
  fareCents: 1500,
  currency: 'PEN',
  distanceMeters: 5000,
  durationSeconds: 600,
  paymentMethod: 'CASH',
  childMode: false,
  penaltyCents: 0,
  // proto3 manda '' cuando el cierre aún no se selló; el BFF lo re-mapea a null en la vista.
  passengerClosedAt: '',
};

/** tripGrpc.call despacha por nombre de método para poder distinguir GetTrip / GetPendingSettlementTrip / CloseTripByPassenger. */
function makeService(handlers: Record<string, (req: unknown) => unknown>) {
  const call = vi.fn((method: string, req: unknown) => {
    const h = handlers[method];
    return Promise.resolve(h ? h(req) : { found: false });
  });
  const tripGrpc = { call } as unknown as GrpcServiceClient;
  const stub = {
    call: vi.fn().mockResolvedValue({ found: false }),
  } as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  // rating rest del enrich (MI rating): sin rating en estos casos → rechaza → fetchMyRatingStars da null.
  const ratingRestStub = {
    get: vi.fn().mockRejectedValue(new Error('no rating')),
  } as unknown as InternalRestClient;
  // Enriquecimiento best-effort: no hay driver/vehicle → buildTripDetail con nulls.
  const svc = new TripsService(
    tripGrpc,
    stub, // identity
    stub, // rating
    stub, // fleet
    stub, // payment
    restStub, // trip rest
    restStub, // dispatch rest
    restStub, // payment rest
    ratingRestStub, // rating rest (MI rating del enrich)
    livekit,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    { get: async () => null, set: async () => 'OK' } as never,
    {} as unknown as DriverEnrichmentService,
    {} as unknown as DispatchService,
  );
  return { svc, call };
}

describe('TripsService.getPendingSettlement', () => {
  it('devuelve el detalle enriquecido cuando hay cierre pendiente', async () => {
    const { svc, call } = makeService({ GetPendingSettlementTrip: () => TRIP_REPLY });
    const view = await svc.getPendingSettlement(user);
    expect(view?.id).toBe('trip-1');
    expect(view?.status).toBe('COMPLETED');
    // proto3 '' → null: un pendiente está, por definición, aún sin cerrar.
    expect(view?.passengerClosedAt).toBeNull();
    expect(call).toHaveBeenCalledWith(
      'GetPendingSettlementTrip',
      { passengerId: 'usr-1' },
      expect.anything(),
    );
  });

  it('null si no hay cierre pendiente (found=false → 204 en el controller)', async () => {
    const { svc } = makeService({ GetPendingSettlementTrip: () => ({ found: false }) });
    expect(await svc.getPendingSettlement(user)).toBeNull();
  });
});

describe('TripsService.close', () => {
  it('gate anti-IDOR (GetTrip) + delega a CloseTripByPassenger con userId del JWT', async () => {
    const closeReq: { id?: string; passengerId?: string } = {};
    const { svc, call } = makeService({
      GetTrip: () => TRIP_REPLY,
      CloseTripByPassenger: (req) => {
        Object.assign(closeReq, req);
        return TRIP_REPLY;
      },
    });
    const view = await svc.close(user, 'trip-1');
    expect(view.id).toBe('trip-1');
    expect(closeReq).toEqual({ id: 'trip-1', passengerId: 'usr-1' });
    expect(call).toHaveBeenCalledWith('GetTrip', { id: 'trip-1' }, expect.anything());
  });

  it('expone passengerClosedAt sellado cuando el close devuelve el viaje ya cerrado', async () => {
    const sealedAt = '2026-06-06T12:00:00.000Z';
    const { svc } = makeService({
      GetTrip: () => TRIP_REPLY,
      CloseTripByPassenger: () => ({ ...TRIP_REPLY, passengerClosedAt: sealedAt }),
    });
    const view = await svc.close(user, 'trip-1');
    expect(view.passengerClosedAt).toBe(sealedAt);
  });

  it('403 si el viaje no pertenece al pasajero (no llama a close)', async () => {
    const close = vi.fn();
    const { svc } = makeService({
      GetTrip: () => ({ ...TRIP_REPLY, passengerId: 'otro' }),
      CloseTripByPassenger: () => {
        close();
        return TRIP_REPLY;
      },
    });
    await expect(svc.close(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 403 });
    expect(close).not.toHaveBeenCalled();
  });

  it('404 si el viaje no existe', async () => {
    const { svc } = makeService({ GetTrip: () => ({ found: false }) });
    await expect(svc.close(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 404 });
  });
});
