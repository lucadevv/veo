/**
 * Bandeja de notificaciones del pasajero. Proxy de LECTURA al notification-service, dueño de las
 * plantillas i18n y del render (el BFF no conoce las keys internas ni interpola). El `recipientId`
 * se DERIVA del JWT (anti-IDOR): el cliente nunca elige de quién son las notificaciones.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_NOTIFICATION } from '../infra/downstream.tokens';
import type { AppNotificationView, MarkAllReadResultView } from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  constructor(@Inject(REST_NOTIFICATION) private readonly notificationRest: InternalRestClient) {}

  /** Lista los avisos in-app del pasajero autenticado (PUSH renderizado, más recientes primero). */
  async list(user: AuthenticatedUser, limit?: number): Promise<AppNotificationView[]> {
    // recipientId = userId del JWT, JAMÁS del cliente (anti-IDOR): solo ves TUS notificaciones.
    // El `read` viaja derivado por el notification-service (read_at != null); el BFF solo proxya.
    return this.notificationRest.get<AppNotificationView[]>('/notifications/inbox', {
      identity: user,
      query: { recipientId: user.userId, limit },
    });
  }

  /**
   * Marca UNA notificación como leída. El notification-service deriva el dueño de la identidad firmada
   * (anti-IDOR): el `id` del path se valida contra el destinatario de sesión downstream. 204 sin body.
   */
  async markRead(user: AuthenticatedUser, id: string): Promise<void> {
    await this.notificationRest.patch<void>(`/notifications/${id}/read`, { identity: user });
  }

  /** Marca TODAS mis notificaciones de la bandeja como leídas. Devuelve cuántas cambió. */
  async markAllRead(user: AuthenticatedUser): Promise<MarkAllReadResultView> {
    return this.notificationRest.patch<MarkAllReadResultView>('/notifications/read-all', {
      identity: user,
    });
  }
}
