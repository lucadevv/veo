import {
  getNotifications,
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
    // MVP: el backend aún NO trackea leído/no-leído. Marcamos `true` para no mostrar un badge de
    // "no leídos" que nunca se limpiaría (degradación honesta). El read real es un follow-up (read_at).
    read: true,
  };
}

/**
 * Implementación REAL de `NotificationsRepository` contra el public-bff (`GET /notifications`). El
 * aviso llega YA renderizado y categorizado por el notification-service; acá solo mapeamos
 * `category → kind` (presentación). Reemplaza al `EmptyNotificationsRepository` (bandeja vacía honesta).
 */
export class HttpNotificationsRepository implements NotificationsRepository {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<AppNotification[]> {
    const items = await getNotifications(this.http);
    return items.map(toAppNotification);
  }
}
