/**
 * Gateway Socket.IO del namespace `/passenger`: seguimiento en vivo del propio viaje del pasajero.
 * Handshake AUTENTICADO: `auth.token` (Bearer JWT, se exige `type==='passenger'`) + `auth.tripId`.
 * Se verifica vía gRPC (GetTrip) que el viaje sea de ESE pasajero y esté activo; entonces el socket
 * se une a la sala de su viaje y recibe `driver:location`, `trip:update`, `eta`, `trip:ended`.
 * Lo alimenta el MISMO consumidor Kafka que sirve a `/family` (no se altera el comportamiento de /family).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  PASSENGER_NAMESPACE,
  type ChatMessage,
  type DriverLocationMsg,
  type EtaMsg,
  type OfferMadeMsg,
  type OfferWithdrawnMsg,
  type PassengerClientToServer,
  type PassengerServerToClient,
  type TripStatus,
  type TripUpdateMsg,
  type WaypointProposalOutcome,
} from '@veo/api-client';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_AUDIENCE,
  JWT_SERVICE,
  Public,
  toAuthenticatedUser,
  type AuthenticatedUser,
  type InternalAudience,
  type JwtService,
} from '@veo/auth';
import { GrpcServiceClient } from '@veo/rpc';
import { createLogger, type Logger } from '@veo/observability';
import { GRPC_TRIP } from '../infra/downstream.tokens';
import type { TripReply } from '../infra/grpc-types';
import { RealtimeStateService } from './realtime-state.service';
import { passengerRoom } from '../share/share.types';

type PassengerServer = Server<PassengerClientToServer, PassengerServerToClient>;
type PassengerSocket = Socket<PassengerClientToServer, PassengerServerToClient>;

/** Estados en los que el pasajero todavía tiene un viaje "activo" que seguir. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'REQUESTED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
  // PUJA · estados TRANSITORIOS recuperables: el pasajero debe poder (re)conectar para ver el board
  // re-abierto (REASSIGNING) o la puja sin ofertas (EXPIRED). Sin esto, una reconexión tras una caída
  // justo en estos estados queda rechazada ("viaje no activo") y el pasajero se cuelga.
  'REASSIGNING',
  'EXPIRED',
]);

// @Public(): los guards globales HTTP (JWT/rate-limit) no interceptan los handlers WS; aquí
// validamos el Bearer a mano en el handshake.
@Public()
@Injectable()
@WebSocketGateway({
  namespace: PASSENGER_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class PassengerGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: PassengerServer;

  private readonly logger: Logger = createLogger('public-bff:passenger');

  constructor(
    @Inject(JWT_SERVICE) private readonly jwt: JwtService,
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
    private readonly state: RealtimeStateService,
  ) {}

  async handleConnection(client: PassengerSocket): Promise<void> {
    try {
      const user = await this.authenticate(client);
      const tripId = this.extractTripId(client);
      if (!tripId) {
        this.reject(client, 'TRIP_REQUIRED', 'Falta el id del viaje activo');
        return;
      }
      await this.authorizeTrip(user, tripId);
      await client.join(passengerRoom(tripId));
      this.state.addPassenger(client.id, tripId);
      this.logger.info({ tripId, sid: client.id }, 'pasajero suscrito al seguimiento de su viaje');
      this.emitSnapshot(tripId);
    } catch (err) {
      this.logger.warn({ err, sid: client.id }, 'handshake /passenger rechazado');
      this.reject(client, 'UNAUTHORIZED', 'No autorizado para seguir este viaje');
    }
  }

  handleDisconnect(client: PassengerSocket): void {
    this.state.removePassenger(client.id);
  }

  /** El pasajero pide re-emitir el último snapshot conocido (al volver de background, etc.). */
  @SubscribeMessage('resync')
  resync(@ConnectedSocket() client: PassengerSocket): void {
    const tripId = this.tripForSocket(client);
    if (tripId) this.emitSnapshot(tripId);
  }

  // ── API interna usada por el consumidor Kafka (mismas señales que /family) ──

  emitTripUpdate(tripId: string, msg: TripUpdateMsg): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('trip:update', msg);
    }
  }

  emitDriverLocation(tripId: string, msg: DriverLocationMsg): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('driver:location', msg);
    }
  }

  emitEta(tripId: string, msg: EtaMsg): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('eta', msg);
    }
  }

  emitTripEnded(tripId: string, status: TripStatus, at: string): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('trip:ended', { tripId, status, at });
    }
  }

  /** Emite un mensaje de chat (Ola 2A) a la sala del viaje del pasajero. */
  emitChatMessage(tripId: string, msg: ChatMessage): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('chat:message', msg);
    }
  }

  /** Emite una oferta entrante de la puja (ADR 010) a la sala del viaje del pasajero. */
  emitOfferMade(tripId: string, msg: OfferMadeMsg): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('offer:made', msg);
    }
  }

  /** BE-3 · una oferta dejó de ser válida: el pasajero la quita por driverId (board sigue abierto). */
  emitOfferWithdrawn(tripId: string, msg: OfferWithdrawnMsg): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('offer:withdrawn', msg);
    }
  }

  /** Lote C4 · desenlace de una parada propuesta (aceptada/rechazada/vencida) a la sala del pasajero. */
  emitWaypointOutcome(tripId: string, msg: WaypointProposalOutcome): void {
    if (this.state.isPassengerActive(tripId)) {
      this.server.to(passengerRoom(tripId)).emit('waypoint:outcome', msg);
    }
  }

  private async authenticate(client: PassengerSocket): Promise<AuthenticatedUser> {
    const token = this.extractToken(client);
    if (!token) throw new Error('falta el token de acceso');
    const claims = await this.jwt.verifyAccess(token);
    const user = toAuthenticatedUser(claims);
    if (user.type !== 'passenger') {
      throw new Error('el socket /passenger es exclusivo de pasajeros');
    }
    return user;
  }

  /** Verifica vía gRPC que el viaje exista, sea de este pasajero y siga activo. */
  private async authorizeTrip(user: AuthenticatedUser, tripId: string): Promise<void> {
    const meta = grpcIdentityMetadata(user, this.secret, this.audience);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new Error('viaje no encontrado');
    if (trip.passengerId !== user.userId) throw new Error('el viaje no pertenece al pasajero');
    if (!ACTIVE_STATUSES.has(trip.status)) throw new Error('el viaje no está activo');
  }

  /**
   * Emite el último estado y ubicación conocidos al pasajero que (re)conecta.
   *
   * ADR-020 Lote 1 · reconexión en la PUJA: la LISTA DE OFERTAS no se replica por socket. Se recupera del
   * lado del cliente vía su query REST `['trip', id, 'offers']` (React Query: cache persistente + poll de 5s
   * + refetch al reconectar), que fusiona con las ofertas vivas de `offer:made`. Aquí solo re-empujamos el
   * `trip:update` con el status vigente: eso basta para que la app re-derive la fase (REQUESTED→buscando/
   * ofertas) y re-pinte el board. Deliberadamente NO mantenemos las ofertas en RealtimeStateService —
   * duplicaría el board efímero AUTORITATIVO de dispatch (Redis+TTL) y arrastraría PII. El status empujado
   * ya no es un EXPIRED stale porque `onBidPosted`/`onOfferMade` lo fijan a REQUESTED con el board abierto.
   */
  private emitSnapshot(tripId: string): void {
    const status = this.state.getStatus(tripId);
    const loc = this.state.getLocation(tripId);
    const eta = this.state.getEta(tripId);
    if (status) {
      this.emitTripUpdate(tripId, {
        tripId,
        status,
        etaSeconds: eta,
        driverLocation: loc?.point ?? null,
        at: new Date().toISOString(),
      });
    }
    if (loc) {
      this.emitDriverLocation(tripId, {
        tripId,
        driverId: '',
        point: loc.point,
        heading: null,
        speedKph: null,
        at: loc.at,
      });
    }
  }

  private tripForSocket(client: PassengerSocket): string | undefined {
    // Re-deriva desde las salas a las que pertenece el socket (excluye su sala propia = client.id).
    for (const room of client.rooms) {
      if (room !== client.id) return room.replace(/^trip:/, '');
    }
    return undefined;
  }

  private extractToken(client: PassengerSocket): string | undefined {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token) return auth.token.replace(/^Bearer\s+/i, '');
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return undefined;
  }

  private extractTripId(client: PassengerSocket): string | undefined {
    const auth = client.handshake.auth as { tripId?: string } | undefined;
    if (auth?.tripId) return auth.tripId;
    const q = client.handshake.query?.tripId;
    if (typeof q === 'string' && q.length > 0) return q;
    return undefined;
  }

  private reject(client: PassengerSocket, code: string, message: string): void {
    client.emit('error', { code, message });
    client.disconnect(true);
  }
}
