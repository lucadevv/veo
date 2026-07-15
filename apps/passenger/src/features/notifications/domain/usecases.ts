import type {AppNotification} from './entities';
import type {NotificationsRepository} from './notificationsRepository';

/** Lista los avisos del centro de notificaciones del pasajero, más recientes primero. */
export class ListNotificationsUseCase {
  constructor(private readonly repository: NotificationsRepository) {}

  execute(): Promise<AppNotification[]> {
    return this.repository.list();
  }
}

/** Marca UNA notificación como leída (al abrirla). El dueño lo deriva el backend del JWT (anti-IDOR). */
export class MarkNotificationReadUseCase {
  constructor(private readonly repository: NotificationsRepository) {}

  execute(id: string): Promise<void> {
    return this.repository.markRead(id);
  }
}

/** Marca TODAS las notificaciones del pasajero como leídas ("marcar todo leído"). */
export class MarkAllNotificationsReadUseCase {
  constructor(private readonly repository: NotificationsRepository) {}

  execute(): Promise<void> {
    return this.repository.markAllRead();
  }
}
