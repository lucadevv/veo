import {
  getNotificationPrefs,
  updateNotificationPrefs,
  type HttpClient,
  type NotificationPrefs,
} from '@veo/api-client';
import type {NotificationPrefsRepository} from '../domain/notificationPrefsRepository';

/**
 * Implementación REAL de `NotificationPrefsRepository` contra el public-bff (`GET/PUT
 * /notification-prefs`). El `userId` lo deriva el backend de la identidad firmada (anti-IDOR).
 */
export class HttpNotificationPrefsRepository implements NotificationPrefsRepository {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<NotificationPrefs> {
    return getNotificationPrefs(this.http);
  }

  update(prefs: NotificationPrefs): Promise<NotificationPrefs> {
    return updateNotificationPrefs(this.http, prefs);
  }
}
