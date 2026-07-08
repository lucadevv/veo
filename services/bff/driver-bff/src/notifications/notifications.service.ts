/**
 * Notificaciones del conductor. Lista las del destinatario autenticado (recipientId = userId).
 * Lectura por REST (notification-service no expone listado por gRPC, solo Get por id).
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import { RestGateway } from '../infra/rest.gateway';
import type { RegisterDeviceTokenDto } from './dto/device-token.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly rest: RestGateway) {}

  listMine(identity: AuthenticatedUser, limit?: number): Promise<unknown> {
    // Bandeja RENDERIZADA (título+cuerpo por i18n), igual que el pasajero — NO el listado operacional
    // crudo (/notifications, template keys). recipientId = userId del JWT, JAMÁS del cliente (anti-IDOR).
    return this.rest.client('notification').get('/notifications/inbox', {
      identity,
      query: { recipientId: identity.userId, limit },
    });
  }

  /** Registra el token de push del conductor en notification-service (identidad interna firmada). */
  registerDeviceToken(identity: AuthenticatedUser, dto: RegisterDeviceTokenDto): Promise<void> {
    return this.rest.client('notification').post<void>('/internal/devices', {
      identity,
      body: dto,
    });
  }

  /** Elimina un token de push del conductor. */
  removeDeviceToken(identity: AuthenticatedUser, token: string): Promise<void> {
    return this.rest
      .client('notification')
      .delete<void>(`/internal/devices/${encodeURIComponent(token)}`, { identity });
  }
}
