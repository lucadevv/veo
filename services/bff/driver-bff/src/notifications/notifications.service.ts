/**
 * Notificaciones del conductor. Lista las del destinatario autenticado (recipientId = userId).
 * Lectura por REST (notification-service no expone listado por gRPC, solo Get por id).
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import { RestGateway } from '../infra/rest.gateway';
import type { RegisterDeviceTokenDto } from './dto/device-token.dto';

/** Resultado de PATCH /notifications/read-all: cuántas pasaron a leídas (shape del notification-service). */
export interface MarkAllReadResultView {
  updated: number;
}

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

  /**
   * Marca UN aviso como leído (proxy firmado a notification-service PATCH /notifications/:id/read).
   * El dueño lo deriva el downstream de la identidad propagada (anti-IDOR): marcar un aviso ajeno da 404.
   */
  markRead(identity: AuthenticatedUser, id: string): Promise<void> {
    return this.rest
      .client('notification')
      .patch<void>(`/notifications/${encodeURIComponent(id)}/read`, { identity });
  }

  /** Marca TODOS mis avisos como leídos (PATCH /notifications/read-all). Devuelve cuántos cambió. */
  markAllRead(identity: AuthenticatedUser): Promise<MarkAllReadResultView> {
    return this.rest
      .client('notification')
      .patch<MarkAllReadResultView>('/notifications/read-all', { identity });
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
