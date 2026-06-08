import type { AppNotification } from '../domain/entities';
import type { NotificationsRepository } from '../domain/notificationsRepository';

/**
 * Implementación HONESTA del centro de avisos mientras el `public-bff` no expone el listado.
 *
 * Devuelve SIEMPRE una lista vacía: no se inventan avisos. La pantalla muestra entonces su estado
 * vacío ("No tienes avisos"). Cuando el endpoint de listado exista, se reemplaza por una
 * `HttpNotificationsRepository` bajo el mismo token de DI, sin tocar dominio ni presentación.
 */
export class EmptyNotificationsRepository implements NotificationsRepository {
  list(): Promise<AppNotification[]> {
    return Promise.resolve([]);
  }
}
