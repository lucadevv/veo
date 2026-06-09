import { describe, it, expect, vi } from 'vitest';
import { OpsGateway, matchesWatch, type OpsWatch } from './ops.gateway';
import type { WsTicketService, WsTicketUser } from './ws-ticket.service';
import type { JwtService, AuthenticatedUser } from '@veo/auth';
import type { PanicAlertMsg, TripUpdateMsg, DriverLocationMsg } from '@veo/api-client';

describe('matchesWatch', () => {
  it('sin filtro recibe todo', () => {
    expect(matchesWatch(undefined, { tripId: 't1' })).toBe(true);
    expect(matchesWatch({}, { tripId: 't1' })).toBe(true);
  });

  it('filtra por tripId', () => {
    const w: OpsWatch = { tripId: 't1' };
    expect(matchesWatch(w, { tripId: 't1' })).toBe(true);
    expect(matchesWatch(w, { tripId: 't2' })).toBe(false);
  });

  it('filtra por bbox [minLon,minLat,maxLon,maxLat]', () => {
    const w: OpsWatch = { bbox: [-77.1, -12.2, -76.9, -12.0] };
    expect(matchesWatch(w, { point: { lat: -12.1, lon: -77.0 } })).toBe(true);
    expect(matchesWatch(w, { point: { lat: -13.0, lon: -77.0 } })).toBe(false);
    // bbox sin punto en el evento → no encaja
    expect(matchesWatch(w, {})).toBe(false);
  });
});

interface FakeSocket {
  data: { user?: unknown; watch?: OpsWatch };
  emit: ReturnType<typeof vi.fn>;
}

function gatewayWithSockets(sockets: FakeSocket[]): OpsGateway {
  const gateway = new OpsGateway({} as unknown as JwtService, {} as unknown as WsTicketService);
  const ns = { sockets: new Map(sockets.map((s, i) => [String(i), s])) };
  // server es privado: lo inyectamos para la prueba.
  (gateway as unknown as { server: unknown }).server = {
    ...ns,
    emit: vi.fn(),
  };
  return gateway;
}

describe('OpsGateway emisión', () => {
  it('PRIORIDAD: panic:alert ignora el watch PERO respeta el rol (solo panics:view)', () => {
    // COMPLIANCE_SUPERVISOR tiene panics:view; FINANCE tiene ops:view pero NO panics:view; anon no autenticado.
    const viewer: FakeSocket = { data: { user: { roles: ['COMPLIANCE_SUPERVISOR'] }, watch: { tripId: 'otro' } }, emit: vi.fn() };
    const finance: FakeSocket = { data: { user: { roles: ['FINANCE'] } }, emit: vi.fn() };
    const anon: FakeSocket = { data: {}, emit: vi.fn() };
    const gateway = gatewayWithSockets([viewer, finance, anon]);
    const msg: PanicAlertMsg = {
      panicId: 'pa1',
      tripId: 't1',
      passengerId: 'p1',
      geo: { lat: -12, lon: -77 },
      status: 'TRIGGERED',
      triggeredAt: '2026-05-29T00:00:00.000Z',
    };
    gateway.emitPanicAlert(msg);
    // El viewer lo recibe AUNQUE su watch mire otro viaje (la prioridad ignora el filtro geográfico)…
    expect(viewer.emit).toHaveBeenCalledWith('panic:alert', msg);
    // …pero FINANCE (sin panics:view) y el anónimo NO — antes el server.emit se los filtraba a todos (PII Ley 29733).
    expect(finance.emit).not.toHaveBeenCalled();
    expect(anon.emit).not.toHaveBeenCalled();
  });

  it('trip:update solo llega a sockets cuyo watch encaja', () => {
    const watching: FakeSocket = { data: { user: { userId: 'a' }, watch: { tripId: 't1' } }, emit: vi.fn() };
    const other: FakeSocket = { data: { user: { userId: 'b' }, watch: { tripId: 't2' } }, emit: vi.fn() };
    const anon: FakeSocket = { data: {}, emit: vi.fn() }; // no autenticado → ignorado
    const gateway = gatewayWithSockets([watching, other, anon]);
    const msg: TripUpdateMsg = { tripId: 't1', status: 'IN_PROGRESS', etaSeconds: null, driverLocation: null, at: 'x' };
    gateway.emitTripUpdate(msg);
    expect(watching.emit).toHaveBeenCalledWith('trip:update', msg);
    expect(other.emit).not.toHaveBeenCalled();
    expect(anon.emit).not.toHaveBeenCalled();
  });

  it('driver:location respeta el bbox del watch', () => {
    const inside: FakeSocket = {
      data: { user: { userId: 'a' }, watch: { bbox: [-77.1, -12.2, -76.9, -12.0] } },
      emit: vi.fn(),
    };
    const gateway = gatewayWithSockets([inside]);
    const msg: DriverLocationMsg = {
      tripId: '',
      driverId: 'd1',
      point: { lat: -12.1, lon: -77.0 },
      heading: null,
      speedKph: null,
      at: 'x',
    };
    gateway.emitDriverLocation(msg);
    expect(inside.emit).toHaveBeenCalledWith('driver:location', msg);
  });
});

interface HandshakeSocket {
  handshake: { auth: Record<string, unknown>; headers: Record<string, string | undefined> };
  data: { user?: AuthenticatedUser; watch?: OpsWatch };
  disconnect: ReturnType<typeof vi.fn>;
}

function handshakeSocket(auth: Record<string, unknown>): HandshakeSocket {
  return { handshake: { auth, headers: {} }, data: {}, disconnect: vi.fn() };
}

function gatewayWithTickets(consume: WsTicketService['consume']): OpsGateway {
  const wsTickets = { consume, mint: vi.fn() } as unknown as WsTicketService;
  return new OpsGateway({} as unknown as JwtService, wsTickets);
}

describe('OpsGateway handshake por ticket', () => {
  const ticketUser: WsTicketUser = {
    userId: 'a1',
    type: 'admin',
    roles: ['ADMIN'],
    sessionId: 's1',
    mfaAt: 1234,
  };

  it('acepta el handshake cuando el ticket es válido y es admin', async () => {
    const gateway = gatewayWithTickets(vi.fn().mockResolvedValue(ticketUser));
    const socket = handshakeSocket({ ticket: 'good-ticket' });
    await gateway.handleConnection(socket as never);
    expect(socket.data.user).toEqual({
      userId: 'a1',
      type: 'admin',
      roles: ['ADMIN'],
      sessionId: 's1',
      mfaVerifiedAt: 1234,
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('rechaza el handshake cuando el ticket es inválido/expirado (consume → null)', async () => {
    const gateway = gatewayWithTickets(vi.fn().mockResolvedValue(null));
    const socket = handshakeSocket({ ticket: 'bad-or-expired' });
    await gateway.handleConnection(socket as never);
    expect(socket.data.user).toBeUndefined();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza el ticket cuya identidad no es de tipo admin', async () => {
    const gateway = gatewayWithTickets(
      vi.fn().mockResolvedValue({ ...ticketUser, type: 'passenger' }),
    );
    const socket = handshakeSocket({ ticket: 'wrong-type' });
    await gateway.handleConnection(socket as never);
    expect(socket.data.user).toBeUndefined();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rechaza un admin SIN rol de ops:view (ej. SUPPORT_L1) — la UI lo esconde, el socket también', async () => {
    const gateway = gatewayWithTickets(vi.fn().mockResolvedValue({ ...ticketUser, roles: ['SUPPORT_L1'] }));
    const socket = handshakeSocket({ ticket: 'support-l1' });
    await gateway.handleConnection(socket as never);
    expect(socket.data.user).toBeUndefined();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('sin ticket ni token Bearer cierra la conexión', async () => {
    const consume = vi.fn();
    const gateway = gatewayWithTickets(consume);
    const socket = handshakeSocket({});
    await gateway.handleConnection(socket as never);
    expect(consume).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
