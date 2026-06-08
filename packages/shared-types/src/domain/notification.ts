import type { NotificationChannel, NotificationStatus } from '../enums/index.js';

/** Notificación entregada por el motor propio (push/SMS/email/webhook). */
export interface Notification {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  dedupKey?: string;
  attempts: number;
  sentAt?: Date;
  deliveredAt?: Date;
  failedReason?: string;
  createdAt: Date;
}
