import type {NotificationPrefs} from '@veo/api-client';

/**
 * Puerto de PREFERENCIAS de notificación (DIP). FUENTE DE VERDAD server-side (notification-service):
 * sincroniza entre dispositivos y sobrevive reinstalación. La presentación/el store dependen de esta
 * abstracción; la impl HTTP es sustituible bajo el mismo token de DI sin tocar UI.
 */
export interface NotificationPrefsRepository {
  /** GET mis preferencias (el server devuelve defaults si nunca guardé). */
  get(): Promise<NotificationPrefs>;
  /** PUT reemplaza el objeto COMPLETO de preferencias (idempotente). */
  update(prefs: NotificationPrefs): Promise<NotificationPrefs>;
}
