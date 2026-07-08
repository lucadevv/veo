import type { HttpClient } from '@veo/api-client';
import { z } from 'zod';
import type {
  AppNotification,
  NotificationKind,
  NotificationsRepository,
} from '../../domain';

/**
 * IMPLEMENTACIÓN REAL del `NotificationsRepository` contra el `driver-bff` (`GET /notifications`).
 *
 * ── Forma REAL del endpoint (verificada, 2026-07) ──────────────────────────────────────────────
 * El `driver-bff` (`notifications.controller.ts`) proxya a notification-service `GET /notifications`
 * (el listado OPERACIONAL `listByRecipient`), que devuelve `NotificationView[]`:
 *   { id, recipientId, channel, template, status, attempts, maxAttempts, dedupKey, nextAttemptAt,
 *     sentAt, deliveredAt, failedReason, createdAt, deduped? }
 * NO trae `title`/`body`/`category` RENDERIZADOS: solo la `template` KEY (p. ej. `driver.approved`) y el
 * `channel`. Esto DIFIERE del pasajero, cuyo `public-bff` apunta a `GET /notifications/inbox` (la vista
 * `InboxNotificationView` = { id, category, title, body, createdAt }, ya renderizada por el motor i18n).
 *
 * El fix LIMPIO es de backend (1 línea: que el `driver-bff` proxye a `/notifications/inbox` en vez de
 * `/notifications`). Como acá NO tocamos backend, este adaptador DEGRADA de forma HONESTA:
 *   - `kind` se deriva de la FAMILIA de la template key (`categoryForTemplate`, misma regla que el motor).
 *   - `title`/`body` se resuelven con un shim es-PE por template (`describeTemplate`) — copy sobria, sin
 *     placeholders (el payload de render no llega en la vista operacional). Fallback GENÉRICO por categoría.
 * El schema es DEFENSIVO y acepta TAMBIÉN la vista renderizada (title/body/category): el día que el BFF
 * apunte a `/notifications/inbox`, esos campos fluyen tal cual y el shim queda BYPASSEADO sin tocar la app.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Schema DEFENSIVO del ítem de la respuesta. Solo `id` es obligatorio; el resto es opcional para tolerar
 * AMBAS formas (renderizada + operacional) y variantes de naming (camelCase / snake_case). `.passthrough()`
 * conserva campos desconocidos sin romper (forward-compat).
 */
const notificationDto = z
  .object({
    id: z.string(),
    // Fecha de emisión (camelCase real; snake_case tolerado por si el naming cambia).
    createdAt: z.string().optional(),
    created_at: z.string().optional(),
    // Vista RENDERIZADA (contrato correcto: `/notifications/inbox`) — opcional.
    title: z.string().optional(),
    body: z.string().optional(),
    category: z.string().optional(),
    // Vista OPERACIONAL (realidad actual: `/notifications`) — opcional.
    template: z.string().optional(),
    channel: z.string().optional(),
    // Estado leído/no-leído (aún no lo trackea el backend; se HONRA si algún día llega).
    read: z.boolean().optional(),
    readAt: z.string().nullable().optional(),
    read_at: z.string().nullable().optional(),
  })
  .passthrough();

type NotificationDto = z.infer<typeof notificationDto>;

const notificationList = z.array(notificationDto);

/** Categoría pública (semántica del motor de notificaciones) → `kind` (ícono/tono en la app). */
const KIND_BY_CATEGORY: Record<string, NotificationKind> = {
  trip: 'TRIP',
  safety: 'SAFETY',
  payment: 'RECEIPT',
  promo: 'PROMO',
  general: 'GENERAL',
};

/**
 * Deriva la categoría a partir de la FAMILIA (prefijo) de la template key. Replica
 * `categoryForTemplate` de notification-service (única fuente de la regla) para el modo DEGRADADO en el
 * que el endpoint solo entrega la key (sin `category` renderizada).
 */
function categoryForTemplate(key: string): NotificationKind {
  if (key.startsWith('trip.') || key.startsWith('chat.')) return 'TRIP';
  if (key.startsWith('panic.') || key.startsWith('contact.')) return 'SAFETY';
  if (key.startsWith('payment.') || key.startsWith('payout.')) return 'RECEIPT';
  if (key.startsWith('promo.')) return 'PROMO';
  return 'GENERAL';
}

/**
 * Copy es-PE (tuteo) por template para el modo DEGRADADO (la vista operacional no trae título/cuerpo
 * renderizados). Cubre los templates que apuntan al CONDUCTOR; el resto cae al genérico por categoría.
 * Sin placeholders: el payload de render no viaja en la vista operacional (por eso no hay `{{amount}}`).
 */
const TEMPLATE_COPY: Record<string, { title: string; body: string }> = {
  'driver.approved': {
    title: '¡Ya puedes manejar!',
    body: 'Tu cuenta de conductor fue aprobada. Abre VEO y empieza tu primer turno.',
  },
  'driver.rejected': {
    title: 'Revisa tu solicitud',
    body: 'Tu solicitud de conductor necesita correcciones. Abre VEO para ver el motivo y reenviar.',
  },
  'fleet.document_rejected': {
    title: 'Revisa tu documento',
    body: 'Uno de tus documentos necesita correcciones. Abre VEO para ver cuál y volver a enviarlo.',
  },
  'fleet.vehicle_model_approved': {
    title: 'Modelo aprobado',
    body: 'Tu vehículo ya está habilitado para trabajar.',
  },
  'fleet.vehicle_model_rejected': {
    title: 'Modelo rechazado',
    body: 'Tu solicitud de modelo no fue aprobada. Contacta a soporte.',
  },
  'payout.processed': {
    title: 'Tu liquidación se procesó',
    body: 'Tu liquidación va en camino a tu billetera.',
  },
  'payment.penalty_driver_comp': {
    title: 'Compensación por espera',
    body: 'Recibiste una compensación por la cancelación de un pasajero. Se suma a tu liquidación.',
  },
  'chat.message': {
    title: 'Nuevo mensaje',
    body: 'Tu pasajero te escribió. Abre el chat para responder.',
  },
};

/** Título/cuerpo genéricos por categoría (último recurso: template desconocida y sin render). */
const GENERIC_COPY: Record<NotificationKind, { title: string; body: string }> = {
  TRIP: { title: 'Actualización de tu viaje', body: 'Tienes una novedad en tu viaje.' },
  SAFETY: { title: 'Aviso de seguridad', body: 'Tienes un aviso de seguridad. Ábrelo para ver el detalle.' },
  RECEIPT: { title: 'Movimiento de tu cuenta', body: 'Tienes un movimiento en tu cuenta.' },
  PROMO: { title: 'Novedad VEO', body: 'Tienes una novedad de VEO.' },
  GENERAL: { title: 'Nuevo aviso', body: 'Tienes un aviso nuevo en VEO.' },
};

function resolveKind(dto: NotificationDto): NotificationKind {
  if (dto.category) {
    const mapped = KIND_BY_CATEGORY[dto.category];
    if (mapped) {
      return mapped;
    }
  }
  if (dto.template) {
    return categoryForTemplate(dto.template);
  }
  return 'GENERAL';
}

function resolveRead(dto: NotificationDto): boolean {
  // Se HONRA un `read` explícito si el backend lo empieza a enviar. Si solo hay `readAt`, presencia = leído.
  // Sin señal de lectura (realidad actual): `true` — evita un badge de "no leídos" que nunca se limpiaría
  // (misma degradación honesta que el pasajero; el `read` real es un follow-up de backend).
  if (typeof dto.read === 'boolean') {
    return dto.read;
  }
  const readAt = dto.readAt ?? dto.read_at;
  if (readAt != null) {
    return true;
  }
  return true;
}

function toAppNotification(dto: NotificationDto): AppNotification {
  const kind = resolveKind(dto);
  const renderedTitle = dto.title?.trim();
  const renderedBody = dto.body?.trim();
  // 1) Renderizado por el motor (contrato correcto). 2) Shim por template. 3) Genérico por categoría.
  const templateCopy = dto.template ? TEMPLATE_COPY[dto.template] : undefined;
  const fallback = templateCopy ?? GENERIC_COPY[kind] ?? GENERIC_COPY.GENERAL;
  return {
    id: dto.id,
    kind,
    title: renderedTitle || fallback.title,
    body: renderedBody || fallback.body,
    createdAt: dto.createdAt ?? dto.created_at ?? '',
    read: resolveRead(dto),
  };
}

/** Implementación HTTP del `NotificationsRepository` contra el `driver-bff`. */
export class HttpNotificationsRepository implements NotificationsRepository {
  constructor(private readonly http: HttpClient) {}

  async getNotifications(limit?: number): Promise<AppNotification[]> {
    // El `recipientId` lo deriva el BFF del JWT (anti-IDOR): NO viaja acá. El HttpClient arma el query
    // string (RN no tiene URL.searchParams) y valida la respuesta con el schema defensivo.
    const items = await this.http.get('/notifications', {
      query: { limit },
      schema: notificationList,
    });
    return items.map(toAppNotification);
  }
}
