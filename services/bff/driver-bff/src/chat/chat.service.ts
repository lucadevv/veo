/**
 * Chat in-app del conductor (Ola 2A). Valida que el viaje está asignado a ESTE conductor (gRPC:
 * resuelve driverId desde el userId y lo compara con trip.driverId) y que el viaje está activo,
 * luego delega persistencia/lectura a chat-service (REST firmado). La entrega en tiempo real al
 * pasajero la hace el flujo Kafka (chat.message_sent → public-bff Socket.IO).
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { ChatMessage } from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply, TripReply } from '../common/grpc-replies';

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
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  async list(identity: AuthenticatedUser, tripId: string, limit?: number): Promise<ChatMessage[]> {
    await this.assertDriverTrip(identity, tripId, false); // solo valida membresía; el id no se usa al listar
    return this.rest.client('chat').get<ChatMessage[]>(`/chat/trips/${tripId}/messages`, {
      identity,
      query: { limit },
    });
  }

  async send(identity: AuthenticatedUser, tripId: string, body: string): Promise<ChatMessage> {
    const { driverId, passengerId } = await this.assertDriverTrip(identity, tripId, true);
    return this.rest.client('chat').post<ChatMessage>(`/chat/trips/${tripId}/messages`, {
      identity,
      // passengerId (de GetTrip): el DESTINATARIO del push cuando el conductor escribe. Viaja al
      // evento chat.message_sent → notification-service pushea al pasajero (dedup por messageId).
      body: { senderId: driverId, senderRole: 'DRIVER', body, passengerId },
    });
  }

  /**
   * Verifica que el viaje es de ESTE conductor y (si requireActive) está activo. Devuelve su driverId
   * y el passengerId del viaje (para enriquecer el evento de chat con el destinatario del push).
   */
  private async assertDriverTrip(
    identity: AuthenticatedUser,
    tripId: string,
    requireActive: boolean,
  ): Promise<{ driverId: string; passengerId: string | undefined }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) throw new ForbiddenException('No existe perfil de conductor para el usuario');

    const trip = await this.grpc.call<TripReply>('trip', 'GetTrip', { id: tripId }, identity);
    if (!trip.found) throw new NotFoundException('Viaje no encontrado');
    if (trip.driverId !== driver.id) {
      throw new ForbiddenException('El viaje no está asignado a este conductor');
    }
    if (requireActive && !ACTIVE_STATUSES.has(trip.status)) {
      throw new ForbiddenException('El chat solo está disponible durante un viaje activo');
    }
    return { driverId: driver.id, passengerId: trip.passengerId };
  }
}
