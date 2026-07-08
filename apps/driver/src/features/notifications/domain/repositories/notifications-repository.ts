import type { AppNotification } from '../entities';

/**
 * Contrato del repositorio de avisos del conductor (capa domain). Implementación concreta en `data/`.
 * La presentación depende de esta ABSTRACCIÓN (DIP), no de la impl HTTP.
 */
export interface NotificationsRepository {
  /**
   * GET /notifications — bandeja del conductor autenticado, más recientes primero. El `recipientId` lo
   * deriva el BFF del JWT (anti-IDOR): el cliente nunca elige de quién son los avisos. `limit` acota la
   * página (el servidor lo re-estrecha).
   */
  getNotifications(limit?: number): Promise<AppNotification[]>;
}
