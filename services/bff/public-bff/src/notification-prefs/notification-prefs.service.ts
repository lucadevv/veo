/**
 * Preferencias in-app de notificaciones (lado pasajero). Proxy firmado a notification-service
 * (`/notification-prefs`), dueño de la persistencia. El `userId` lo deriva el servicio downstream de
 * la identidad firmada; aquí solo se reenvía el cuerpo.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { NotificationPrefs } from '@veo/api-client';
import { REST_NOTIFICATION } from '../infra/downstream.tokens';

@Injectable()
export class NotificationPrefsService {
  constructor(@Inject(REST_NOTIFICATION) private readonly notificationRest: InternalRestClient) {}

  get(user: AuthenticatedUser): Promise<NotificationPrefs> {
    return this.notificationRest.get<NotificationPrefs>('/notification-prefs', { identity: user });
  }

  put(user: AuthenticatedUser, prefs: NotificationPrefs): Promise<NotificationPrefs> {
    return this.notificationRest.put<NotificationPrefs>('/notification-prefs', {
      identity: user,
      body: prefs,
    });
  }
}
