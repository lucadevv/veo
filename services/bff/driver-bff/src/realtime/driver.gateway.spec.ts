import { describe, it, expect, vi } from 'vitest';
import type { VehicleClass } from '@veo/shared-types';
import { DriverGateway } from './driver.gateway';
import { roomForDriver } from './rooms';

function makeGateway(opts: {
  verify?: () => Promise<{ sub: string; typ: string; roles: never[]; sid: string }>;
  driverFound?: boolean;
  driverId?: string;
  suspendedAt?: string;
  publish?: ReturnType<typeof vi.fn>;
}) {
  const jwt = {
    verifyAccess:
      opts.verify ??
      (() => Promise.resolve({ sub: 'usr-1', typ: 'driver', roles: [] as never[], sid: 'sess-1' })),
  };
  const grpc = {
    call: vi.fn(() =>
      Promise.resolve({
        id: opts.driverId ?? 'drv-9',
        userId: 'usr-1',
        found: opts.driverFound ?? true,
        // "" = NO suspendido (proto3 default); ISO = suspendido. El gate del handshake usa Boolean(...).
        suspendedAt: opts.suspendedAt ?? '',
      }),
    ),
  };
  const publisher = {
    publishDriverLocation: opts.publish ?? vi.fn(() => Promise.resolve(true)),
  };
  // Resolver del tipo activo: por defecto devuelve el `fallback` (lo que vino en el ping), así las
  // aserciones de tipo de los tests existentes no cambian. Su lógica real se testea aparte (fleet).
  const activeVehicleType = {
    // B5-3: resolve devuelve el vehículo activo resuelto ({vehicleType, +attrs de eligibilidad opcionales}).
    resolve: vi.fn((_identity: unknown, fallback: VehicleClass) =>
      Promise.resolve({ vehicleType: fallback }),
    ),
  };
  const config = { getOrThrow: () => '' };
  // Denylist de revocación: por defecto NO revocado (assertNotRevoked resuelve). Su enforcement en el
  // handshake corre en el middleware (afterInit), no en handleConnection; acá solo satisface el constructor.
  const revocation = {
    assertNotRevoked: vi.fn(() => Promise.resolve()),
  };
  const gateway = new DriverGateway(
    jwt as never,
    grpc as never,
    publisher as never,
    activeVehicleType as never,
    revocation as never,
    config as never,
  );
  return { gateway, grpc, publisher, activeVehicleType, revocation };
}

function fakeSocket(token?: string) {
  return {
    id: 'sock-1',
    handshake: { auth: token ? { token } : {}, headers: {} as Record<string, string> },
    data: {} as Record<string, unknown>,
    join: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
    emit: vi.fn(),
  };
}

/**
 * Mock del server socket.io con la superficie CROSS-NODO que usa el gateway multi-réplica: `in(room)` →
 * BroadcastOperator con `emit`/`disconnectSockets`/`fetchSockets`, `serverSideEmit` (anuncio inter-servidor)
 * y `to(room)` (fan-out del push). Con el redis-adapter montado, estas ops se propagan a otros pods.
 */
function makeServerMock() {
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  const fetchSockets = vi.fn((): Promise<{ id: string }[]> => Promise.resolve([{ id: 's1' }]));
  const inOp = { emit, disconnectSockets, fetchSockets };
  const to = vi.fn(() => ({ emit }));
  const server = {
    in: vi.fn(() => inOp),
    to,
    serverSideEmit: vi.fn(),
    on: vi.fn(),
  };
  return { server, inOp, emit, disconnectSockets, fetchSockets };
}

/** Inyecta un server mock en el gateway (el `@WebSocketServer()` que Nest cablea en runtime). */
function attachServer(gateway: DriverGateway, server: unknown): void {
  (gateway as unknown as { server: unknown }).server = server;
}

/** Invoca el handler privado del anuncio inter-servidor (lo registra `afterInit` en runtime). */
function fireSupersede(gateway: DriverGateway, payload: { driverId: string; sid: string }): void {
  (
    gateway as unknown as { onSupersedeBroadcast: (p: { driverId: string; sid: string }) => void }
  ).onSupersedeBroadcast(payload);
}

describe('DriverGateway', () => {
  it('une el socket a la sala del driverId tras verificar el JWT', async () => {
    const { gateway } = makeGateway({ driverId: 'drv-42' });
    const socket = fakeSocket('Bearer abc.def.ghi');
    await gateway.handleConnection(socket as never);
    expect(socket.join).toHaveBeenCalledWith(roomForDriver('drv-42'));
    expect(socket.data.driverId).toBe('drv-42');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('rechaza (disconnect) cuando falta el token', async () => {
    const { gateway } = makeGateway({});
    const socket = fakeSocket(undefined);
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('rechaza a un sujeto que no es driver', async () => {
    const { gateway } = makeGateway({
      verify: () =>
        Promise.resolve({ sub: 'usr-2', typ: 'passenger', roles: [] as never[], sid: 's' }),
    });
    const socket = fakeSocket('tok');
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza cuando el usuario no tiene perfil de conductor', async () => {
    const { gateway } = makeGateway({ driverFound: false });
    const socket = fakeSocket('tok');
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza (disconnect) a un conductor SUSPENDIDO en el handshake (gate del re-login)', async () => {
    const { gateway } = makeGateway({ driverId: 'drv-42', suspendedAt: '2026-07-01T00:00:00.000Z' });
    const socket = fakeSocket('Bearer abc.def.ghi');
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.data.driverId).toBeUndefined();
  });

  it('disconnectSuspendedDriver emite session:suspended y disconnectSockets en la sala (cross-nodo)', async () => {
    vi.useFakeTimers();
    const { gateway } = makeGateway({});
    const { server, emit, disconnectSockets, fetchSockets } = makeServerMock();
    fetchSockets.mockReturnValue(Promise.resolve([{ id: 's1' }, { id: 's2' }]));
    attachServer(gateway, server);
    const count = await gateway.disconnectSuspendedDriver('drv-42');
    expect(count).toBe(2); // conteo HONESTO cross-nodo (fetchSockets), no un inventado.
    expect(server.in).toHaveBeenCalledWith(roomForDriver('drv-42'));
    expect(emit).toHaveBeenCalledWith('session:suspended');
    vi.runAllTimers();
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it('disconnectSuspendedDriver devuelve 0 (NO_DRIVER) y NO cierra si no hay sockets en el cluster', async () => {
    const { gateway } = makeGateway({});
    const { server, emit, disconnectSockets, fetchSockets } = makeServerMock();
    fetchSockets.mockReturnValue(Promise.resolve([]));
    attachServer(gateway, server);
    expect(await gateway.disconnectSuspendedDriver('drv-x')).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(disconnectSockets).not.toHaveBeenCalled();
  });

  it('disconnectSuspendedDriver es no-op (0) si el server aún no está listo', async () => {
    const { gateway } = makeGateway({});
    expect(await gateway.disconnectSuspendedDriver('drv-x')).toBe(0);
  });

  it('disconnectSuspendedDriver degrada a -1 (indeterminado) si fetchSockets falla, pero igual emite el cierre', async () => {
    const { gateway } = makeGateway({});
    const { server, emit, fetchSockets } = makeServerMock();
    fetchSockets.mockReturnValue(Promise.reject(new Error('redis down')));
    attachServer(gateway, server);
    const count = await gateway.disconnectSuspendedDriver('drv-42');
    expect(count).toBe(-1);
    expect(emit).toHaveBeenCalledWith('session:suspended'); // best-effort: emite aunque no pudo contar.
  });

  it('supersede cross-nodo: echa el socket local si su sid es MÁS VIEJO que el ganador', async () => {
    vi.useFakeTimers();
    // makeGateway verifica sid 'sess-1' para la sesión local.
    const { gateway } = makeGateway({ driverId: 'drv-42' });
    const socket = fakeSocket('Bearer t');
    await gateway.handleConnection(socket as never); // Map: drv-42 → sid 'sess-1'
    fireSupersede(gateway, { driverId: 'drv-42', sid: 'sess-2' }); // ganador más nuevo en otro pod
    expect(socket.emit).toHaveBeenCalledWith('session:superseded');
    vi.runAllTimers();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it('supersede cross-nodo: NO echa si el sid local es igual/más nuevo, ni si el driver es desconocido (no-op)', async () => {
    const { gateway } = makeGateway({ driverId: 'drv-42' }); // sid local 'sess-1'
    const socket = fakeSocket('Bearer t');
    await gateway.handleConnection(socket as never);
    fireSupersede(gateway, { driverId: 'drv-42', sid: 'sess-0' }); // más viejo → el local no pierde
    fireSupersede(gateway, { driverId: 'drv-42', sid: 'sess-1' }); // igual → no pierde
    fireSupersede(gateway, { driverId: 'otro', sid: 'sess-9' }); // driver que este pod no tiene → no-op
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('emitToDriver publica en la sala correcta del servidor', () => {
    const { gateway } = makeGateway({});
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    (gateway as unknown as { server: { to: typeof to } }).server = { to };
    gateway.emitToDriver('drv-7', 'dispatch:offer', { matchId: 'm1' });
    expect(to).toHaveBeenCalledWith(roomForDriver('drv-7'));
    expect(emit).toHaveBeenCalledWith('dispatch:offer', { matchId: 'm1' });
  });

  it('emitToDriver no falla si el servidor aún no está listo', () => {
    const { gateway } = makeGateway({});
    expect(() => gateway.emitToDriver('drv-7', 'x', {})).not.toThrow();
  });
});

describe('DriverGateway evento location', () => {
  const report = {
    lat: -12.0464,
    lon: -77.0428,
    heading: 90,
    speed: 8.3,
    accuracy: 5,
    ts: '2026-05-29T00:00:00.000Z',
  };

  it('publica driver.location_updated y responde ack ok', async () => {
    const publish = vi.fn(() => Promise.resolve(true));
    const { gateway } = makeGateway({ publish });
    const client = { data: { driverId: 'drv-1', identity: { userId: 'usr-1', type: 'driver' } } };
    const ack = await gateway.onLocation(client as never, report);
    expect(ack).toEqual({ ok: true });
    // El BFF SELLA el tipo server-authoritative (resolver mock → fallback 'CAR' porque el report no lo trae).
    expect(publish).toHaveBeenCalledWith('drv-1', { ...report, vehicleType: 'CAR' });
  });

  it('rechaza si el socket no está autenticado (sin driverId)', async () => {
    const publish = vi.fn();
    const { gateway } = makeGateway({ publish });
    const client = { data: {} };
    const ack = await gateway.onLocation(client as never, report);
    expect(ack).toEqual({ ok: false, error: 'unauthenticated' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rechaza un reporte inválido (sin publicar)', async () => {
    const publish = vi.fn();
    const { gateway } = makeGateway({ publish });
    const client = { data: { driverId: 'drv-1', identity: { userId: 'usr-1', type: 'driver' } } };
    const ack = await gateway.onLocation(client as never, { lat: 999, lon: 0, ts: 'x' });
    expect(ack).toEqual({ ok: false, error: 'invalid_report' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('refleja fallo de publicación en el ack', async () => {
    const publish = vi.fn(() => Promise.resolve(false));
    const { gateway } = makeGateway({ publish });
    const client = { data: { driverId: 'drv-1', identity: { userId: 'usr-1', type: 'driver' } } };
    const ack = await gateway.onLocation(client as never, report);
    expect(ack).toEqual({ ok: false, error: 'publish_failed' });
  });
});
