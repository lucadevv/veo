/**
 * Bandeja de notificaciones del pasajero. Proxy de LECTURA al notification-service, dueño de las
 * plantillas i18n y del render (el BFF no conoce las keys internas ni interpola). El `recipientId`
 * se DERIVA del JWT (anti-IDOR): el cliente nunca elige de quién son las notificaciones.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_NOTIFICATION } from '../infra/downstream.tokens';
import type { AppNotificationView } from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(REST_NOTIFICATION) private readonly notificationRest: InternalRestClient,
  ) {}

  /** Lista los avisos in-app del pasajero autenticado (PUSH renderizado, más recientes primero). */
  async list(user: AuthenticatedUser, limit?: number): Promise<AppNotificationView[]> {
    // recipientId = userId del JWT, JAMÁS del cliente (anti-IDOR): solo ves TUS notificaciones.
    return this.notificationRest.get<AppNotificationView[]>('/notifications/inbox', {
      identity: user,
      query: { recipientId: user.userId, limit },
    });
  }
}
