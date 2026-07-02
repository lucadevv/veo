/**
 * Historial de viajes en el BFF (TripsService.getTripHistory): anti-IDOR (passengerId del JWT, NUNCA
 * del query), paginación por cursor (pass-through al gRPC) y shape de la vista mobile (estados
 * normalizados, '' → null, SIN nombre de conductor). Dobles sin Nest DI, al estilo de trip-closure.spec.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { TripsService } from './trips.service';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { LiveKitConfig } from '../share/livekit-token';
import type { TripHistoryItemReply, PassengerTripsReply } from '../infra/grpc-types';

const SECRET = 'dev-internal-secret-change-me';
const livekit: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function item(over: Partial<TripHistoryItemReply> = {}): TripHistoryItemReply {
  return {
    id: 'trip-1',
    status: 'COMPLETED',
    originLat: -12.04,
    originLng: -77.04,
    destinationLat: -12.12,
    destinationLng: -77.02,
    fareCents: 1500,
    currency: 'PEN',
    paymentMethod: 'CASH',
    distanceMeters: 4200,
    durationSeconds: 900,
    requestedAt: '2026-06-03T10:00:00.000Z',
    completedAt: '2026-06-03T10:30:00.000Z',
    cancelledAt: '',
    driverId: 'drv-1',
    vehicleType: 'CAR',
    category: '',
    ...over,
  };
}

/** Construye el TripsService con un gRPC double que captura el request de ListPassengerTrips. */
function makeService(reply: PassengerTripsReply) {
  const call = vi.fn().mockResolvedValue(reply);
  const tripGrpc = { call } as unknown as GrpcServiceClient;
  const stub = {
    call: vi.fn().mockResolvedValue({ found: false }),
  } as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  const svc = new TripsService(
    tripGrpc,
    stub, // identity
    stub, // rating
    stub, // fleet
    stub, // payment
    restStub, // trip rest
    restStub, // dispatch rest
    restStub, // payment rest
    restStub, // rating rest
    livekit,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    { get: async () => null, set: async () => 'OK' } as never,
    {} as unknown as DriverEnrichmentService,
    {} as unknown as DispatchService,
  );
  return { svc, call };
}

describe('TripsService.getTripHistory · anti-IDOR', () => {
  it('manda el passengerId del JWT al gRPC, NUNCA un id del cliente', async () => {
    const { svc, call } = makeService({ items: [item()], nextCursor: '' });
    await svc.getTripHistory(user, undefined, undefined);
    expect(call).toHaveBeenCalledWith(
      'ListPassengerTrips',
      // passengerId = user.userId del JWT. cursor '' y limit 0 (el servidor clampa).
      { passengerId: 'usr-1', cursor: '', limit: 0 },
      expect.anything(),
    );
  });

  it('aunque el caller pase otro id por parámetro, el gRPC SIEMPRE recibe el del JWT (no hay forma de inyectarlo)', async () => {
    // getTripHistory no acepta passengerId: su firma es (user, cursor?, limit?). El id sale solo del user.
    const { svc, call } = makeService({ items: [], nextCursor: '' });
    await svc.getTripHistory({ ...user, userId: 'usr-1' }, 'cur', 10);
    const req = call.mock.calls[0]![1] as { passengerId: string };
    expect(req.passengerId).toBe('usr-1');
  });
});

describe('TripsService.getTripHistory · paginación', () => {
  it('propaga cursor + limit al gRPC tal cual', async () => {
    const { svc, call } = makeService({ items: [item()], nextCursor: 'next-token' });
    const page = await svc.getTripHistory(user, 'cur-abc', 5);
    expect(call).toHaveBeenCalledWith(
      'ListPassengerTrips',
      { passengerId: 'usr-1', cursor: 'cur-abc', limit: 5 },
      expect.anything(),
    );
    expect(page.nextCursor).toBe('next-token');
  });

  it("nextCursor '' del proto3 → null (no hay más páginas)", async () => {
    const { svc } = makeService({ items: [item()], nextCursor: '' });
    const page = await svc.getTripHistory(user);
    expect(page.nextCursor).toBeNull();
  });
});

describe('TripsService.getTripHistory · shape de la card', () => {
  it('normaliza estado, re-mapea ruta lat/lng y los opcionales ("" → null); SIN nombre de conductor', async () => {
    const { svc } = makeService({
      items: [
        item({
          status: 'CANCELLED_BY_DRIVER', // se colapsa a CANCELLED (alias de dominio)
          completedAt: '',
          cancelledAt: '2026-06-03T10:05:00.000Z',
          driverId: '',
          category: '',
        }),
      ],
      nextCursor: '',
    });
    const page = await svc.getTripHistory(user);
    const it0 = page.items[0]!;
    expect(it0.status).toBe('CANCELLED'); // alias dominio→mobile
    expect(it0.origin).toEqual({ lat: -12.04, lng: -77.04 });
    expect(it0.destination).toEqual({ lat: -12.12, lng: -77.02 });
    expect(it0.completedAt).toBeNull();
    expect(it0.cancelledAt).toBe('2026-06-03T10:05:00.000Z');
    expect(it0.driverId).toBeNull(); // viaje sin conductor
    expect(it0.category).toBeNull();
    // anti-N+1: la card no trae nombre/rating del conductor.
    expect(it0).not.toHaveProperty('driver');
    expect(it0).not.toHaveProperty('driverName');
  });

  it('mapea un viaje COMPLETED con conductor (driverId presente, sin nombre)', async () => {
    const { svc } = makeService({
      items: [item({ driverId: 'drv-9', category: 'veo_xl' })],
      nextCursor: '',
    });
    const page = await svc.getTripHistory(user);
    expect(page.items[0]).toMatchObject({
      status: 'COMPLETED',
      driverId: 'drv-9',
      category: 'veo_xl',
      vehicleType: 'CAR',
      fareCents: 1500,
    });
  });
});
