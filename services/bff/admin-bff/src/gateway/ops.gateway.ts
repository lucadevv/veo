/**
 * OpsGateway — namespace Socket.IO `/ops` para el monitor de operación/seguridad del admin-web.
 * - Handshake autenticado por TICKET efímero (auth.ticket): el navegador nunca ve el JWT (vive en
 *   cookie httpOnly de admin-web). El ticket se consume una sola vez contra Redis.
 * - Fallback: Bearer JWT admin (auth.token o header Authorization) para clientes que sí poseen el token
 *   (p. ej. servicios internos / pruebas). En ambos casos se exige claims/type='admin'.
 * - El cliente envía `watch` con bbox/tripId para filtrar el tráfico que recibe.
 * - PRIORIDAD DE PÁNICO: las alertas de pánico se difunden a TODOS los sockets, ignorando el filtro
 *   watch (un incidente crítico no puede perderse por estar mirando otra zona). trip/driver sí filtran.
 * Tipado con OpsServerToClient/OpsClientToServer de @veo/api-client.
 */
import { Inject, Logger as NestLogger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import { Namespace, Socket, type DefaultEventsMap } from 'socket.io';
import { JWT_SERVICE, type JwtService, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import {
  OPS_NAMESPACE,
  type OpsServerToClient,
  type OpsClientToServer,
  type DriverLocationMsg,
  type TripUpdateMsg,
  type PanicAlertMsg,
} from '@veo/api-client';
import { WsTicketService } from './ws-ticket.service';

/**
 * Gating por ROL del monitor /ops (la UI esconde, pero el socket NO autoriza solo — defensa server-side).
 * Espejo EXACTO del rbac del admin-web: `ops:view` para conectarse, `panics:view` para recibir pánicos.
 * SUPPORT_L1 no tiene ninguno; FINANCE tiene ops:view pero NO panics:view.
 */
const OPS_VIEW_ROLES: readonly AdminRole[] = [
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.FINANCE,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];
const PANIC_VIEW_ROLES: readonly AdminRole[] = [
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
];

function hasAnyRole(user: AuthenticatedUser, allowed: readonly AdminRole[]): boolean {
  return user.roles.some((role) => allowed.includes(role));
}

export interface OpsWatch {
  bbox?: [number, number, number, number];
  tripId?: string;
}

interface OpsSocketData {
  user?: AuthenticatedUser;
  watch?: OpsWatch;
}

type OpsSocket = Socket<OpsClientToServer, OpsServerToClient, DefaultEventsMap, OpsSocketData>;
type OpsNamespace = Namespace<OpsClientToServer, OpsServerToClient, DefaultEventsMap, OpsSocketData>;

@WebSocketGateway({ namespace: OPS_NAMESPACE })
export class OpsGateway implements OnGatewayConnection {
  private readonly logger = new NestLogger('OpsGateway');

  @WebSocketServer()
  private readonly server!: OpsNamespace;

  constructor(
    @Inject(JWT_SERVICE) private readonly jwt: JwtService,
    private readonly wsTickets: WsTicketService,
  ) {}

  async handleConnection(socket: OpsSocket): Promise<void> {
    try {
      const user = await this.authenticate(socket);
      if (!user) throw new Error('handshake no autorizado');
      socket.data.user = user;
    } catch {
      // Handshake inválido: se cierra la conexión (sin filtrar el motivo al cliente no autenticado).
      socket.disconnect(true);
    }
  }

  /**
   * Autentica el handshake Y gatea por ROL: además de exigir type='admin', el usuario debe tener
   * un rol con `ops:view`. Sin esto, un SUPPORT_L1 (que la UI no deja entrar) igual abriría el socket
   * por `curl`/cliente directo y recibiría tráfico de operación. La UI refleja; el socket autoriza.
   */
  private async authenticate(socket: OpsSocket): Promise<AuthenticatedUser | null> {
    const user = await this.resolveIdentity(socket);
    if (!user) return null;
    if (!hasAnyRole(user, OPS_VIEW_ROLES)) return null; // gate de rol server-side (no solo la UI)
    return user;
  }

  /**
   * Resuelve la identidad del handshake. Prioriza el ticket efímero (consumo único en Redis);
   * si no hay ticket, cae al Bearer JWT. En ambos casos exige una identidad de tipo 'admin'.
   */
  private async resolveIdentity(socket: OpsSocket): Promise<AuthenticatedUser | null> {
    const ticket = this.extractTicket(socket);
    if (ticket) {
      const ticketUser = await this.wsTickets.consume(ticket);
      if (ticketUser?.type !== 'admin') return null;
      return {
        userId: ticketUser.userId,
        type: ticketUser.type,
        roles: ticketUser.roles,
        sessionId: ticketUser.sessionId,
        mfaVerifiedAt: ticketUser.mfaAt,
      };
    }

    const token = this.extractToken(socket);
    if (!token) return null;
    const claims = await this.jwt.verifyAccess(token);
    if (claims.typ !== 'admin') return null;
    return {
      userId: claims.sub,
      type: claims.typ,
      roles: claims.roles,
      sessionId: claims.sid,
      mfaVerifiedAt: claims.mfaAt,
    };
  }

  @SubscribeMessage('watch')
  onWatch(@ConnectedSocket() socket: OpsSocket, @MessageBody() msg: OpsWatch): void {
    socket.data.watch = { bbox: msg?.bbox, tripId: msg?.tripId };
  }

  /**
   * Difusión prioritaria de alerta de pánico: ignora el filtro `watch` (un incidente no se pierde por
   * estar mirando otra zona), pero RESPETA el rol — solo a sockets con `panics:view` (no FINANCE/SUPPORT_L1).
   * Antes era `server.emit` a TODOS: un rol sin permiso recibía la alerta + PII (Ley 29733).
   */
  emitPanicAlert(msg: PanicAlertMsg): void {
    for (const socket of this.panicViewers()) socket.emit('panic:alert', msg);
  }

  emitPanicUpdate(msg: { panicId: string; status: string; at: string }): void {
    for (const socket of this.panicViewers()) socket.emit('panic:update', msg);
  }

  /** Sockets autenticados cuyo usuario tiene `panics:view` (los únicos que pueden recibir pánicos). */
  private *panicViewers(): Generator<OpsSocket> {
    for (const socket of this.authenticatedSockets()) {
      if (socket.data.user && hasAnyRole(socket.data.user, PANIC_VIEW_ROLES)) yield socket;
    }
  }

  /** Actualización de viaje: respeta el filtro watch de cada socket. */
  emitTripUpdate(msg: TripUpdateMsg): void {
    for (const socket of this.authenticatedSockets()) {
      if (matchesWatch(socket.data.watch, { tripId: msg.tripId, point: msg.driverLocation })) {
        socket.emit('trip:update', msg);
      }
    }
  }

  /** Ubicación de conductor: respeta el filtro watch (bbox/tripId). */
  emitDriverLocation(msg: DriverLocationMsg): void {
    for (const socket of this.authenticatedSockets()) {
      if (matchesWatch(socket.data.watch, { tripId: msg.tripId || undefined, point: msg.point })) {
        socket.emit('driver:location', msg);
      }
    }
  }

  private *authenticatedSockets(): Generator<OpsSocket> {
    for (const socket of this.server.sockets.values()) {
      if (socket.data.user) yield socket;
    }
  }

  private extractTicket(socket: OpsSocket): string | null {
    const auth = socket.handshake.auth as { ticket?: unknown };
    const ticket: unknown = auth?.ticket;
    return typeof ticket === 'string' && ticket.length > 0 ? ticket : null;
  }

  private extractToken(socket: OpsSocket): string | null {
    const auth = socket.handshake.auth as { token?: unknown };
    const authToken: unknown = auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken.startsWith('Bearer ') ? authToken.slice(7) : authToken;
    }
    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return null;
  }
}

/**
 * Decide si un evento (por tripId o punto geográfico) encaja con el filtro watch del socket.
 * - Sin filtro → recibe todo.
 * - Con tripId → solo ese viaje.
 * - Con bbox → solo si el punto cae dentro de [minLon, minLat, maxLon, maxLat].
 */
export function matchesWatch(
  watch: OpsWatch | undefined,
  evt: { tripId?: string; point?: { lat: number; lon: number } | null },
): boolean {
  if (!watch || (!watch.tripId && !watch.bbox)) return true;
  if (watch.tripId) return evt.tripId === watch.tripId;
  if (watch.bbox && evt.point) {
    const [minLon, minLat, maxLon, maxLat] = watch.bbox;
    return (
      evt.point.lon >= minLon &&
      evt.point.lon <= maxLon &&
      evt.point.lat >= minLat &&
      evt.point.lat <= maxLat
    );
  }
  return false;
}
