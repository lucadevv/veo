import type { AppNotification } from '../entities';
import type { NotificationsRepository } from '../repositories/notifications-repository';

/** Caso de uso: lista los avisos del centro de notificaciones del conductor, más recientes primero. */
export class GetNotificationsUseCase {
  constructor(private readonly notifications: NotificationsRepository) {}

  execute(limit?: number): Promise<AppNotification[]> {
    return this.notifications.getNotifications(limit);
  }
}

/** Caso de uso: marca UN aviso como leído (el owner lo deriva el BFF del JWT; ajeno → 404). */
export class MarkNotificationReadUseCase {
  constructor(private readonly notifications: NotificationsRepository) {}

  execute(id: string): Promise<void> {
    return this.notifications.markRead(id);
  }
}

/** Caso de uso: marca TODOS los avisos del conductor como leídos (apaga el punto de la campana). */
export class MarkAllNotificationsReadUseCase {
  constructor(private readonly notifications: NotificationsRepository) {}

  execute(): Promise<void> {
    return this.notifications.markAllRead();
  }
}
