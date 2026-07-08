import type { AppNotification } from '../entities';
import type { NotificationsRepository } from '../repositories/notifications-repository';

/** Caso de uso: lista los avisos del centro de notificaciones del conductor, más recientes primero. */
export class GetNotificationsUseCase {
  constructor(private readonly notifications: NotificationsRepository) {}

  execute(limit?: number): Promise<AppNotification[]> {
    return this.notifications.getNotifications(limit);
  }
}
