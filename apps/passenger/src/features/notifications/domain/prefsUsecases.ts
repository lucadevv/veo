import type {NotificationPrefs} from '@veo/api-client';
import type {NotificationPrefsRepository} from './notificationPrefsRepository';

/** Trae las preferencias de notificación del pasajero desde el backend (hidratación al montar). */
export class GetNotificationPrefsUseCase {
  constructor(private readonly repository: NotificationPrefsRepository) {}

  execute(): Promise<NotificationPrefs> {
    return this.repository.get();
  }
}

/** Sincroniza el objeto completo de preferencias al backend (PUT idempotente). */
export class UpdateNotificationPrefsUseCase {
  constructor(private readonly repository: NotificationPrefsRepository) {}

  execute(prefs: NotificationPrefs): Promise<NotificationPrefs> {
    return this.repository.update(prefs);
  }
}
