import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification as AppNotificationDto,
  type HttpClient,
  type NotificationCategory,
} from '@veo/api-client';
import type {AppNotification, NotificationKind} from '../domain/entities';
import type {NotificationsRepository} from '../domain/notificationsRepository';

/** `category` (semántica pública del backend) → `kind` (ícono/tono en la app). Mapeo de presentación. */
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
    // `read` REAL del server (read_at != null): ya no se hardcodea. El badge de no-leídos ahora se
    // limpia de verdad (PATCH /notifications/:id/read · read-all).
    read: dto.read,
  };
}

/**
 * Implementación REAL de `NotificationsRepository` contra el public-bff (`GET /notifications` +
 * `PATCH /notifications/:id/read` · `PATCH /notifications/read-all`). El aviso llega YA renderizado y
 * categorizado por el notification-service; acá solo mapeamos `category → kind` (presentación).
 */
export class HttpNotificationsRepository implements NotificationsRepository {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<AppNotification[]> {
    const items = await getNotifications(this.http);
    return items.map(toAppNotification);
  }

  markRead(id: string): Promise<void> {
    return markNotificationRead(this.http, id);
  }

  async markAllRead(): Promise<void> {
    await markAllNotificationsRead(this.http);
  }
}
