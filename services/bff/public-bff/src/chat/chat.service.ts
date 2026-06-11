/**
 * Chat in-app del pasajero (Ola 2A). Valida que el viaje pertenece al pasajero autenticado y que
 * está ACTIVO (gRPC GetTrip), luego delega la persistencia/lectura a chat-service (REST firmado).
 * La entrega en tiempo real al conductor la hace el flujo Kafka (chat.message_sent → driver-bff
 * Socket.IO). El POST devuelve el mensaje persistido para que la app lo pinte de inmediato.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { grpcIdentityMetadata, INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { NotFoundError } from '@veo/utils';
import type { ChatMessage } from '@veo/api-client';
import { GRPC_TRIP, REST_CHAT } from '../infra/downstream.tokens';
import type { TripReply } from '../infra/grpc-types';

/** Estados en los que el chat está habilitado (viaje activo entre sus dos partes). */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
]);

@Injectable()
export class ChatService {
  constructor(
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(REST_CHAT) private readonly chatRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  /** Historial del viaje del pasajero (solo si es suyo). */
  async list(user: AuthenticatedUser, tripId: string, limit?: number): Promise<ChatMessage[]> {
    await this.assertPassengerTrip(user, tripId, false);
    return this.chatRest.get<ChatMessage[]>(`/chat/trips/${tripId}/messages`, {
      identity: user,
      query: { limit },
    });
  }

  /** Envía un mensaje (solo si el viaje es suyo y está activo). */
  async send(user: AuthenticatedUser, tripId: string, body: string): Promise<ChatMessage> {
    await this.assertPassengerTrip(user, tripId, true);
    return this.chatRest.post<ChatMessage>(`/chat/trips/${tripId}/messages`, {
      identity: user,
      // passengerId = el propio pasajero (dueño del viaje, ya validado): viaja al evento para que
      // notification-service resuelva el destinatario del push cuando responda el conductor.
      body: { senderId: user.userId, senderRole: 'PASSENGER', body, passengerId: user.userId },
    });
  }

  /** Verifica que el viaje existe, es del pasajero y (si requireActive) está activo. */
  private async assertPassengerTrip(
    user: AuthenticatedUser,
    tripId: string,
    requireActive: boolean,
  ): Promise<void> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    if (trip.passengerId !== user.userId) {
      throw new ForbiddenException('El viaje no pertenece al pasajero');
    }
    if (requireActive && !ACTIVE_STATUSES.has(trip.status)) {
      throw new ForbiddenException('El chat solo está disponible durante un viaje activo');
    }
  }
}
