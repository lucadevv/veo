import { describe, it, expect, vi } from 'vitest';
import type { VehicleClass } from '@veo/shared-types';
import { DriverGateway } from './driver.gateway';
import { roomForDriver } from './rooms';

function makeGateway(opts: {
  verify?: () => Promise<{ sub: string; typ: string; roles: never[]; sid: string }>;
  driverFound?: boolean;
  driverId?: string;
  publish?: ReturnType<typeof vi.fn>;
}) {
  const jwt = {
    verifyAccess:
      opts.verify ??
      (() => Promise.resolve({ sub: 'usr-1', typ: 'driver', roles: [] as never[], sid: 'sess-1' })),
  };
  const grpc = {
    call: vi.fn(() =>
      Promise.resolve({ id: opts.driverId ?? 'drv-9', userId: 'usr-1', found: opts.driverFound ?? true }),
    ),
  };
  const publisher = {
    publishDriverLocation: opts.publish ?? vi.fn(() => Promise.resolve(true)),
  };
  // Resolver del tipo activo: por defecto devuelve el `fallback` (lo que vino en el ping), así las
  // aserciones de tipo de los tests existentes no cambian. Su lógica real se testea aparte (fleet).
  const activeVehicleType = {
    // B5-3: resolve devuelve el vehículo activo resuelto ({vehicleType, +attrs de eligibilidad opcionales}).
    resolve: vi.fn((_identity: unknown, fallback: VehicleClass) => Promise.resolve({ vehicleType: fallback })),
  };
  const config = { getOrThrow: () => '' };
  const gateway = new DriverGateway(
    jwt as never,
    grpc as never,
    publisher as never,
    activeVehicleType as never,
    config as never,
  );
  return { gateway, grpc, publisher, activeVehicleType };
}

function fakeSocket(token?: string) {
  return {
    id: 'sock-1',
    handshake: { auth: token ? { token } : {}, headers: {} as Record<string, string> },
    data: {} as Record<string, unknown>,
    join: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
  };
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
      verify: () => Promise.resolve({ sub: 'usr-2', typ: 'passenger', roles: [] as never[], sid: 's' }),
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
  const report = { lat: -12.0464, lon: -77.0428, heading: 90, speed: 8.3, accuracy: 5, ts: '2026-05-29T00:00:00.000Z' };

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
