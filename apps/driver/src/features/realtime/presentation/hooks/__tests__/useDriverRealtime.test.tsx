import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DiProvider } from '../../../../../core/di/useDi';
import type { AppContainer } from '../../../../../core/di/container';
import type { DriverSocket } from '../../../../../core/realtime/socket';
import { useDriverRealtime, type DriverRealtimeHandlers } from '../useDriverRealtime';

/**
 * Socket falso controlable: emula el ciclo de vida de socket.io (connect/disconnect re-emiten el
 * mismo evento, como en una reconexión real) sin red. `fire` dispara los listeners registrados con
 * `on` para simular eventos del servidor o transiciones de conexión.
 */
interface FakeSocket {
  on: jest.Mock;
  off: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
  emit: jest.Mock;
}

interface FakeSocketHandle {
  socket: FakeSocket;
  fire: (event: string, arg?: unknown) => void;
}

function createFakeSocket(): FakeSocketHandle {
  const listeners = new Map<string, Set<(arg?: unknown) => void>>();
  const socket: FakeSocket = {
    on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(arg?: unknown) => void>();
      set.add(cb);
      listeners.set(event, set);
      return socket;
    }),
    off: jest.fn((event: string, cb: (arg?: unknown) => void) => {
      listeners.get(event)?.delete(cb);
      return socket;
    }),
    connect: jest.fn(() => socket),
    disconnect: jest.fn(() => socket),
    emit: jest.fn(),
  };
  const fire = (event: string, arg?: unknown): void => {
    listeners.get(event)?.forEach((cb) => cb(arg));
  };
  return { socket, fire };
}

/** Handlers no-op espiables: el test solo observa connect/disconnect/resync. */
function makeHandlers(overrides: Partial<DriverRealtimeHandlers> = {}): DriverRealtimeHandlers {
  return {
    onOffer: jest.fn(),
    onMatch: jest.fn(),
    onBidClosed: jest.fn(),
    onTripUpdate: jest.fn(),
    onChatMessage: jest.fn(),
    onTipAdded: jest.fn(),
    onWaypointProposed: jest.fn(),
    onConnectionChange: jest.fn(),
    onResync: jest.fn(),
    onSessionSuperseded: jest.fn(),
    onSessionRevoked: jest.fn(),
    ...overrides,
  };
}

function HookHost({ handlers }: { handlers: DriverRealtimeHandlers }): null {
  useDriverRealtime(true, handlers);
  return null;
}

describe('useDriverRealtime · resync on reconnect', () => {
  function mount(handlers: DriverRealtimeHandlers, socket: DriverSocket) {
    const container = {
      createDriverSocket: () => socket,
    } as unknown as AppContainer;
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <DiProvider container={container}>
          <HookHost handlers={handlers} />
        </DiProvider>,
      );
    });
    return tree;
  }

  it('NO resincroniza en la primera conexión (las queries ya cargan fresco al montar)', () => {
    const { socket, fire } = createFakeSocket();
    const handlers = makeHandlers();
    mount(handlers, socket as unknown as DriverSocket);

    act(() => fire('connect'));

    expect(handlers.onConnectionChange).toHaveBeenCalledWith(true);
    expect(handlers.onResync).not.toHaveBeenCalled();
  });

  it('resincroniza en la RECONEXIÓN (segundo connect tras un disconnect)', () => {
    const { socket, fire } = createFakeSocket();
    const handlers = makeHandlers();
    mount(handlers, socket as unknown as DriverSocket);

    act(() => fire('connect')); // primera conexión
    act(() => fire('disconnect')); // se cae (túnel)
    act(() => fire('connect')); // reconexión → recuperar lo perdido

    expect(handlers.onResync).toHaveBeenCalledTimes(1);
  });

  it('refleja el estado de conexión al caerse y al volver', () => {
    const { socket, fire } = createFakeSocket();
    const handlers = makeHandlers();
    mount(handlers, socket as unknown as DriverSocket);

    act(() => fire('connect'));
    act(() => fire('disconnect'));

    expect(handlers.onConnectionChange).toHaveBeenNthCalledWith(1, true);
    expect(handlers.onConnectionChange).toHaveBeenNthCalledWith(2, false);
  });

  it('quita los listeners y marca desconectado al desmontar (cleanup)', () => {
    const { socket, fire } = createFakeSocket();
    const handlers = makeHandlers();
    const tree = mount(handlers, socket as unknown as DriverSocket);

    act(() => fire('connect'));
    (handlers.onConnectionChange as jest.Mock).mockClear();
    act(() => tree.unmount());

    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(socket.disconnect).toHaveBeenCalled();
    expect(handlers.onConnectionChange).toHaveBeenLastCalledWith(false);
  });
});
