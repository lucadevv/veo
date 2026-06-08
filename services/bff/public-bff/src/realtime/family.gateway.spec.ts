/** Test de la verificación del token de share en el gateway /family. */
import { describe, it, expect, vi } from 'vitest';
import type { InternalRestClient } from '@veo/rpc';
import { FamilyGateway } from './family.gateway';
import { RealtimeStateService } from './realtime-state.service';
import type { ShareTrackingDownstream } from '../share/share.types';
import { familyRoom } from '../share/share.types';

const view: ShareTrackingDownstream = {
  shareId: 'share-1',
  tripId: 'trip-1',
  status: 'IN_PROGRESS',
  startedAt: null,
  driverId: 'drv-1',
  approximateLocation: null,
  viewedAt: '2026-05-29T00:00:00.000Z',
};

function fakeSocket(token: string | undefined): {
  id: string;
  handshake: { auth: Record<string, unknown> };
  join: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'sock-1',
    handshake: { auth: token === undefined ? {} : { token } },
    join: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('FamilyGateway handshake', () => {
  it('verifica el token, une a la sala del viaje y marca el suscriptor', async () => {
    const state = new RealtimeStateService();
    const shareRest = { get: vi.fn().mockResolvedValue(view) } as unknown as InternalRestClient;
    const gateway = new FamilyGateway(shareRest, state);
    const socket = fakeSocket('tok-valido');

    await gateway.handleConnection(socket as never);

    expect(socket.join).toHaveBeenCalledWith(familyRoom('trip-1'));
    expect(state.isActive('trip-1')).toBe(true);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('rechaza y desconecta si falta el token', async () => {
    const gateway = new FamilyGateway({ get: vi.fn() } as unknown as InternalRestClient, new RealtimeStateService());
    const socket = fakeSocket(undefined);
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_REQUIRED' }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza y desconecta si share-service invalida el token', async () => {
    const shareRest = { get: vi.fn().mockRejectedValue(new Error('forbidden')) } as unknown as InternalRestClient;
    const gateway = new FamilyGateway(shareRest, new RealtimeStateService());
    const socket = fakeSocket('tok-revocado');
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_INVALID' }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

/**
 * SEGURIDAD-CRÍTICA · pánico oculto: el canal /family debe DEJAR de filtrar ubicación/estado en vivo
 * cuando hay un pánico, y los sockets de la familia ya conectados deben ser desconectados.
 */
describe('FamilyGateway corte por pánico', () => {
  function gatewayWithFakeServer(state: RealtimeStateService): {
    gateway: FamilyGateway;
    roomEmit: ReturnType<typeof vi.fn>;
    disconnectSockets: ReturnType<typeof vi.fn>;
  } {
    const roomEmit = vi.fn();
    const disconnectSockets = vi.fn();
    const shareRest = { get: vi.fn() } as unknown as InternalRestClient;
    const gateway = new FamilyGateway(shareRest, state);
    // Servidor Socket.IO falso: .to(room).emit(...) y .in(room).disconnectSockets(...).
    gateway.server = {
      to: vi.fn().mockReturnValue({ emit: roomEmit }),
      in: vi.fn().mockReturnValue({ disconnectSockets }),
    } as never;
    return { gateway, roomEmit, disconnectSockets };
  }

  it('cutFamilyForPanic marca el viaje y desconecta los sockets de la sala', () => {
    const state = new RealtimeStateService();
    state.addSubscriber('sock-1', 'trip-1', 'share-1'); // hay un suscriptor vivo
    const { gateway, disconnectSockets } = gatewayWithFakeServer(state);

    gateway.cutFamilyForPanic('trip-1');

    expect(state.isPanicked('trip-1')).toBe(true);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('NO emite driver:location ni trip:update tras el pánico (aunque haya suscriptores)', () => {
    const state = new RealtimeStateService();
    state.addSubscriber('sock-1', 'trip-1', 'share-1');
    const { gateway, roomEmit } = gatewayWithFakeServer(state);

    gateway.cutFamilyForPanic('trip-1');
    // Evento tardío que llega DESPUÉS del corte: debe quedar suprimido.
    gateway.emitDriverLocation('trip-1', { tripId: 'trip-1' } as never);
    gateway.emitTripUpdate('trip-1', { tripId: 'trip-1' } as never);

    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('un viaje normal (sin pánico) sigue emitiendo en vivo', () => {
    const state = new RealtimeStateService();
    state.addSubscriber('sock-2', 'trip-ok', 'share-2');
    const { gateway, roomEmit } = gatewayWithFakeServer(state);

    gateway.emitDriverLocation('trip-ok', { tripId: 'trip-ok' } as never);

    expect(roomEmit).toHaveBeenCalledWith('driver:location', { tripId: 'trip-ok' });
  });
});
