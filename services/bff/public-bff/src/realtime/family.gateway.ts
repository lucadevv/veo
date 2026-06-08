/**
 * Gateway Socket.IO del namespace /family: seguimiento en vivo desde un enlace firmado.
 * Handshake: auth.token = token de share. Se verifica contra share-service (GET /public/share/:token);
 * si es inválido/expirado/revocado, se emite `error` y se desconecta. Tipado con los mapas de @veo/api-client.
 */
import { Inject } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  FAMILY_NAMESPACE,
  type DriverLocationMsg,
  type FamilyClientToServer,
  type FamilyServerToClient,
  type TripStatus,
  type TripUpdateMsg,
} from '@veo/api-client';
import { InternalRestClient } from '@veo/rpc';
import { Public } from '@veo/auth';
import { createLogger, type Logger } from '@veo/observability';
import { REST_SHARE } from '../infra/downstream.tokens';
import { ANONYMOUS_IDENTITY } from '../infra/internal-identity';
import { RealtimeStateService } from './realtime-state.service';
import { familyRoom, type ShareTrackingDownstream } from '../share/share.types';

type FamilyServer = Server<FamilyClientToServer, FamilyServerToClient>;
type FamilySocket = Socket<FamilyClientToServer, FamilyServerToClient>;

// @Public(): los guards globales (JWT/rate-limit) no deben interceptar los handlers WS.
@Public()
@WebSocketGateway({
  namespace: FAMILY_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class FamilyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: FamilyServer;

  private readonly logger: Logger = createLogger('public-bff:family');

  constructor(
    @Inject(REST_SHARE) private readonly shareRest: InternalRestClient,
    private readonly state: RealtimeStateService,
  ) {}

  async handleConnection(client: FamilySocket): Promise<void> {
    const auth = client.handshake.auth as Record<string, unknown>;
    const token = typeof auth.token === 'string' ? auth.token : null;
    if (!token) {
      this.reject(client, 'TOKEN_REQUIRED', 'Falta el token de seguimiento');
      return;
    }
    await this.authorize(client, token);
  }

  handleDisconnect(client: FamilySocket): void {
    this.state.removeSubscriber(client.id);
  }

  /** El cliente puede re-suscribirse explícitamente (token en el handshake o en el mensaje). */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: FamilySocket,
    @MessageBody() msg: { token: string },
  ): Promise<void> {
    if (!msg?.token) {
      this.reject(client, 'TOKEN_REQUIRED', 'Falta el token de seguimiento');
      return;
    }
    await this.authorize(client, msg.token);
  }

  /** Verifica el token contra share-service y une el socket a la sala del viaje autorizado. */
  private async authorize(client: FamilySocket, token: string): Promise<void> {
    try {
      const view = await this.shareRest.get<ShareTrackingDownstream>(
        `/public/share/${encodeURIComponent(token)}`,
        { identity: ANONYMOUS_IDENTITY },
      );
      await client.join(familyRoom(view.tripId));
      this.state.addSubscriber(client.id, view.tripId, view.shareId);
      this.logger.info({ tripId: view.tripId }, 'familia suscrita al seguimiento');
    } catch {
      this.reject(client, 'TOKEN_INVALID', 'Enlace inválido, expirado o revocado');
    }
  }

  private reject(client: FamilySocket, code: string, message: string): void {
    client.emit('error', { code, message });
    client.disconnect(true);
  }

  // ── API interna usada por el consumidor Kafka y el flujo de revocación ──

  emitTripUpdate(tripId: string, msg: TripUpdateMsg): void {
    // SEGURIDAD-CRÍTICA: durante un pánico nunca emitimos estado en vivo a la familia (fail-safe).
    if (this.state.isPanicked(tripId)) return;
    if (this.state.isActive(tripId)) this.server.to(familyRoom(tripId)).emit('trip:update', msg);
  }

  emitDriverLocation(tripId: string, msg: DriverLocationMsg): void {
    // SEGURIDAD-CRÍTICA: durante un pánico nunca filtramos la ubicación en vivo (fail-safe = ocultar).
    // Defensa en profundidad: aunque el room ya se haya cortado en onPanic, este guard cubre cualquier
    // evento driver.location tardío que llegue después del corte.
    if (this.state.isPanicked(tripId)) return;
    if (this.state.isActive(tripId)) {
      this.server.to(familyRoom(tripId)).emit('driver:location', msg);
    }
  }

  emitTripEnded(tripId: string, status: TripStatus, at: string): void {
    if (this.state.isActive(tripId)) {
      this.server.to(familyRoom(tripId)).emit('trip:ended', { tripId, status, at });
    }
  }

  /** Revoca en vivo todas las sesiones de un enlace: emite link:revoked y desconecta. */
  revokeByShareId(shareId: string): void {
    const tripId = this.state.tripForShare(shareId);
    if (!tripId) return;
    const room = familyRoom(tripId);
    this.server.to(room).emit('link:revoked', { tripId });
    this.server.in(room).disconnectSockets(true);
  }

  /**
   * SEGURIDAD-CRÍTICA · pánico oculto (VEO_SPEC_FAMILIA, fail-safe = ocultar).
   *
   * Al detectar un pánico para un viaje, CORTAMOS el seguimiento en vivo de la familia:
   *  1) Marcamos el viaje como en pánico para que cualquier fan-out (driver:location / trip:update),
   *     incluido el que llegue tarde, quede suprimido de forma idempotente.
   *  2) Desconectamos los sockets de la sala (espejo de revokeByShareId) para que nada más fluya por
   *     la conexión ya abierta de un agresor.
   *
   * A diferencia de revokeByShareId NO emitimos `link:revoked`: ese evento delataría que algo pasó.
   * La familia simplemente pierde la conexión y, en su siguiente poll REST, recibe la vista
   * enmascarada (viaje "TERMINADO" benigno). Si el viaje no tiene sala/suscriptores vivos, el flag
   * queda igual marcado para blindar emisiones futuras.
   */
  cutFamilyForPanic(tripId: string): void {
    this.state.markPanic(tripId);
    const room = familyRoom(tripId);
    this.server.in(room).disconnectSockets(true);
  }
}
