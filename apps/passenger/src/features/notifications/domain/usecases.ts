import type {AppNotification} from './entities';
import type {NotificationsRepository} from './notificationsRepository';

/** Lista los avisos del centro de notificaciones del pasajero, más recientes primero. */
export class ListNotificationsUseCase {
  constructor(private readonly repository: NotificationsRepository) {}

  execute(): Promise<AppNotification[]> {
    return this.repository.list();
  }
}
