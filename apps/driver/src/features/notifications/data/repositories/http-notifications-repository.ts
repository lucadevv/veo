import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification as AppNotificationDto,
  type HttpClient,
  type NotificationCategory,
} from '@veo/api-client';
import type { AppNotification, NotificationKind, NotificationsRepository } from '../../domain';

/** `category` (semántica pública del motor de notificaciones) → `kind` (ícono/tono en la app). */
const KIND_BY_CATEGORY: Record<NotificationCategory, NotificationKind> = {
  trip: 'TRIP',
  safety: 'SAFETY',
  payment: 'RECEIPT',
  promo: 'PROMO',
  general: 'GENERAL',
};

function toAppNotification(dto: AppNotificationDto): AppNotification {
  return {
    id: dto.id,
    kind: KIND_BY_CATEGORY[dto.category],
    title: dto.title,
    body: dto.body,
    createdAt: dto.createdAt,
    // `read` REAL del server (read_at != null): ya no se hardcodea `true`. El borde de acento de la
    // fila y el punto de la campana se apagan con PATCH /notifications/:id/read · read-all.
    read: dto.read,
  };
}

/**
 * Implementación REAL del `NotificationsRepository` contra el driver-bff (`GET /notifications` +
 * `PATCH /notifications/:id/read` · `PATCH /notifications/read-all`), espejo del pasajero.
 *
 * El BFF proxya la bandeja RENDERIZADA de notification-service (`/notifications/inbox`): cada aviso
 * llega con `title`/`body` ya resueltos por el motor i18n, `category` para el ícono/tono y el `read`
 * derivado de `read_at`. El shim degradado por template-key que vivía acá (copy local por
 * `driver.approved`, `resolveRead() = true`, etc.) quedó MUERTO cuando el BFF apuntó al inbox y se
 * eliminó: el contrato compartido (`appNotification` de @veo/api-client) valida la respuesta.
 */
export class HttpNotificationsRepository implements NotificationsRepository {
  constructor(private readonly http: HttpClient) {}

  async getNotifications(limit?: number): Promise<AppNotification[]> {
    // El `recipientId` lo deriva el BFF del JWT (anti-IDOR): NO viaja acá.
    const items = await getNotifications(this.http, { limit });
    return items.map(toAppNotification);
  }

  markRead(id: string): Promise<void> {
    return markNotificationRead(this.http, id);
  }

  async markAllRead(): Promise<void> {
    await markAllNotificationsRead(this.http);
  }
}
