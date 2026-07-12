import type {AppNotification} from './entities';

/**
 * Puerto del centro de avisos (DIP). La presentación depende de esta ABSTRACCIÓN; la impl concreta
 * (HTTP contra el public-bff) es sustituible bajo el mismo token de DI sin tocar dominio ni UI.
 */
export interface NotificationsRepository {
  /** Lista los avisos del pasajero, más recientes primero (cada uno con su estado `read` real). */
  list(): Promise<AppNotification[]>;
  /** Marca UNA notificación como leída (el dueño lo deriva el backend del JWT: anti-IDOR). */
  markRead(id: string): Promise<void>;
  /** Marca TODAS las notificaciones del pasajero como leídas. */
  markAllRead(): Promise<void>;
}
