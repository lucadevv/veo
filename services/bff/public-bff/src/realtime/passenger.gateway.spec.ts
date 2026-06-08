/** Test del handshake autenticado del gateway /passenger y su gating por suscriptor. */
import { describe, it, expect, vi } from 'vitest';
import type { JwtService } from '@veo/auth';
import type { GrpcServiceClient } from '@veo/rpc';
import { PassengerGateway } from './passenger.gateway';
import { RealtimeStateService } from './realtime-state.service';
import { passengerRoom } from '../share/share.types';

const SECRET = 'dev-internal-secret-change-me';

function makeGateway(opts: {
  claims?: { sub: string; typ: string; roles: never[]; sid: string };
  trip?: { found: boolean; passengerId: string; status: string };
}) {
  const jwt = {
    verifyAccess: vi.fn().mockResolvedValue(
      opts.claims ?? { sub: 'usr-1', typ: 'passenger', roles: [] as never[], sid: 'sess-1' },
    ),
  } as unknown as JwtService;
  const tripGrpc = {
    call: vi.fn().mockResolvedValue(
      opts.trip ?? { found: true, passengerId: 'usr-1', status: 'IN_PROGRESS' },
    ),
  } as unknown as GrpcServiceClient;
  const state = new RealtimeStateService();
  const gateway = new PassengerGateway(jwt, tripGrpc, SECRET, state);
  return { gateway, state, jwt, tripGrpc };
}

function fakeSocket(auth: Record<string, unknown>): {
  id: string;
  rooms: Set<string>;
  handshake: { auth: Record<string, unknown>; headers: Record<string, string>; query: Record<string, string> };
  join: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'sock-1',
    rooms: new Set<string>(['sock-1']),
    handshake: { auth, headers: {}, query: {} },
    join: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('PassengerGateway handshake', () => {
  it('verifica JWT de pasajero + propiedad del viaje activo y une a la sala', async () => {
    const { gateway, state } = makeGateway({ trip: { found: true, passengerId: 'usr-1', status: 'IN_PROGRESS' } });
    const socket = fakeSocket({ token: 'Bearer abc.def', tripId: 'trip-1' });
    await gateway.handleConnection(socket as never);
    expect(socket.join).toHaveBeenCalledWith(passengerRoom('trip-1'));
    expect(state.isPassengerActive('trip-1')).toBe(true);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('rechaza si falta el tripId', async () => {
    const { gateway } = makeGateway({});
    const socket = fakeSocket({ token: 'abc' });
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TRIP_REQUIRED' }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza a un sujeto que no es pasajero', async () => {
    const { gateway } = makeGateway({ claims: { sub: 'd1', typ: 'driver', roles: [] as never[], sid: 's' } });
    const socket = fakeSocket({ token: 'abc', tripId: 'trip-1' });
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza si el viaje no pertenece al pasajero', async () => {
    const { gateway } = makeGateway({ trip: { found: true, passengerId: 'otro', status: 'IN_PROGRESS' } });
    const socket = fakeSocket({ token: 'abc', tripId: 'trip-1' });
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza si el viaje no está activo (COMPLETED)', async () => {
    const { gateway } = makeGateway({ trip: { found: true, passengerId: 'usr-1', status: 'COMPLETED' } });
    const socket = fakeSocket({ token: 'abc', tripId: 'trip-1' });
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('PassengerGateway emisiones', () => {
  it('solo emite a la sala si hay un pasajero suscrito al viaje', () => {
    const { gateway, state } = makeGateway({});
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    (gateway as unknown as { server: { to: typeof to } }).server = { to };

    // Sin suscriptores: no emite.
    gateway.emitDriverLocation('trip-9', {
      tripId: 'trip-9',
      driverId: 'd1',
      point: { lat: -12, lon: -77 },
      heading: null,
      speedKph: null,
      at: '2026-05-29T00:00:00.000Z',
    });
    expect(to).not.toHaveBeenCalled();

    // Con un pasajero suscrito: emite a su sala.
    state.addPassenger('sock-1', 'trip-9');
    gateway.emitEta('trip-9', { tripId: 'trip-9', etaSeconds: 120, at: '2026-05-29T00:00:00.000Z' });
    expect(to).toHaveBeenCalledWith(passengerRoom('trip-9'));
    expect(emit).toHaveBeenCalledWith('eta', expect.objectContaining({ etaSeconds: 120 }));
  });
});
