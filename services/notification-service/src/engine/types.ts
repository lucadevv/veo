/**
 * Contratos del motor de notificaciones (puro, sin dependencias de NestJS/Prisma).
 * Permite testear dedup/retry/routing con dobles en memoria (FOUNDATION: dominio sin mocks externos).
 */
import type { NotificationChannel, NotificationStatus } from '@veo/shared-types';

/**
 * Prioridad de drenado del worker (mayor = más urgente). Objeto `as const`, no números mágicos.
 *  - Critical: pánico (SMS a contactos + webhook a central). NUNCA espera detrás de bulk → SLA p99 < 3s.
 *  - Normal: transaccional (viaje, pago, chat). Default.
 *  - Bulk: broadcast/promo masivo. Cede el paso a todo lo demás.
 */
export const NotificationPriority = { Critical: 100, Normal: 0, Bulk: -100 } as const;
export type NotificationPriority = (typeof NotificationPriority)[keyof typeof NotificationPriority];

export interface NotificationRecord {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  priority: number;
  dedupKey: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedReason: string | null;
  createdAt: Date;
}

export interface EnqueueInput {
  recipientId: string;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
  dedupKey?: string;
  maxAttempts?: number;
  /** Prioridad de drenado (default `NotificationPriority.Normal`). */
  priority?: number;
}

export interface CreateNotificationInput {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
  priority: number;
  dedupKey: string | null;
  maxAttempts: number;
  nextAttemptAt: Date;
}

/** Persistencia del motor. La impl Prisma añade el outbox en la MISMA transacción del cambio de estado. */
export interface NotificationStore {
  findByDedupKey(dedupKey: string): Promise<NotificationRecord | null>;
  create(input: CreateNotificationInput): Promise<NotificationRecord>;
  findById(id: string): Promise<NotificationRecord | null>;
  findByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]>;
  /** Bandeja in-app: solo canal PUSH, más recientes primero. */
  findInboxByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]>;
  findDue(now: Date, limit: number): Promise<NotificationRecord[]>;
  /** Riel ACEPTÓ el mensaje (honesto: SENT, NO DELIVERED) + outbox notification.sent. */
  markSent(id: string, args: { to: string; channel: NotificationChannel; attempts: number }): Promise<void>;
  /** Agotado / permanente: FAILED + outbox notification.failed. */
  markFailed(id: string, args: { channel: NotificationChannel; reason: string; attempts: number }): Promise<void>;
  /** Fallo recuperable: reprograma siguiente intento (backoff). */
  scheduleRetry(id: string, args: { attempts: number; nextAttemptAt: Date; reason: string }): Promise<void>;
}

export interface RenderedMessage {
  to: string;
  subject?: string;
  body: string;
}

/** Renderiza una notificación a su mensaje final (resuelve plantilla i18n + variables). */
export interface TemplateRenderer {
  render(rec: NotificationRecord): Promise<RenderedMessage>;
}

/**
 * Estado TIPADO de un despacho a un canal (objeto `as const`, no string literals sueltos).
 *  - `Sent`: el riel aceptó (→ markSent).
 *  - `InvalidRecipient`: destino muerto/baja (token UNREGISTERED/410); el dispatcher YA lo invalidó. Permanente.
 *  - `RateLimited`: quota/throttling; reintentar respetando `retryAfterMs` si el riel lo informó.
 *  - `Transient`: 5xx/red/timeout; reintentar con backoff.
 */
export const DispatchStatus = {
  Sent: 'sent',
  InvalidRecipient: 'invalidRecipient',
  RateLimited: 'rateLimited',
  Transient: 'transient',
} as const;
export type DispatchStatus = (typeof DispatchStatus)[keyof typeof DispatchStatus];

/** El dispatcher NO lanza por rechazos del riel: traduce el resultado del puerto a uno de estos casos. */
export type DispatchResult =
  | { status: typeof DispatchStatus.Sent }
  | { status: typeof DispatchStatus.InvalidRecipient; reason: string }
  | { status: typeof DispatchStatus.RateLimited; retryAfterMs?: number; reason: string }
  | { status: typeof DispatchStatus.Transient; reason: string };

/** Enruta el mensaje renderizado al puerto del canal correspondiente y devuelve el resultado tipado. */
export interface MessageDispatcher {
  dispatch(rec: NotificationRecord, rendered: RenderedMessage): Promise<DispatchResult>;
}

export type DeliveryOutcome =
  | { status: 'SENT'; attempts: number }
  | { status: 'RETRY'; attempts: number; reason: string; nextAttemptAt: Date }
  | { status: 'FAILED'; attempts: number; reason: string };

export interface EnqueueResult {
  notification: NotificationRecord;
  deduped: boolean;
}
