/**
 * NotificationRepository — implementación Prisma de NotificationStore.
 * Las transiciones de estado de éxito/fallo encolan el evento de dominio en el OUTBOX dentro de
 * la MISMA transacción (FOUNDATION §6): consistencia exactly-once efectiva con Kafka.
 */
import { Injectable } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { NotificationChannel, NotificationStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Notification as PrismaNotification } from '../generated/prisma';
import type { CreateNotificationInput, NotificationRecord, NotificationStore } from './types';

function toRecord(row: PrismaNotification): NotificationRecord {
  return {
    id: row.id,
    recipientId: row.recipientId,
    channel: row.channel,
    template: row.template,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status,
    priority: row.priority,
    dedupKey: row.dedupKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    failedReason: row.failedReason,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/** Resultado de marcar UNA notificación como leída (anti-IDOR: distingue no-dueño de ya-leída). */
export type MarkReadOutcome = 'ok' | 'notFound';

@Injectable()
export class NotificationRepository implements NotificationStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByDedupKey(dedupKey: string): Promise<NotificationRecord | null> {
    const row = await this.prisma.read.notification.findUnique({ where: { dedupKey } });
    return row ? toRecord(row) : null;
  }

  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const row = await this.prisma.write.notification.create({
      data: {
        id: input.id,
        recipientId: input.recipientId,
        channel: input.channel,
        template: input.template,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        priority: input.priority,
        dedupKey: input.dedupKey,
        maxAttempts: input.maxAttempts,
        nextAttemptAt: input.nextAttemptAt,
        status: NotificationStatus.PENDING,
      },
    });
    return toRecord(row);
  }

  async findById(id: string): Promise<NotificationRecord | null> {
    const row = await this.prisma.read.notification.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    const rows = await this.prisma.read.notification.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  /**
   * Bandeja in-app: solo canal PUSH (los avisos que el usuario ve EN la app). SMS (OTP/pánico a
   * contactos) y WEBHOOK (central) NO pertenecen a la bandeja del pasajero. Filtra en la query —
   * no trae lo que va a descartar. Servido por @@index([recipientId, createdAt]).
   */
  async findInboxByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    const rows = await this.prisma.read.notification.findMany({
      where: { recipientId, channel: NotificationChannel.PUSH },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  /**
   * Marca UNA notificación como leída, SCOPEADA al destinatario (anti-IDOR: nunca por `id` solo — un
   * usuario no puede marcar la notificación de otro). Idempotente: si ya estaba leída no re-sella la
   * marca (conserva el timestamp original). Devuelve `notFound` si la fila no existe o no es del
   * usuario (el caller responde 404 sin filtrar de quién era: no revela ajenas).
   */
  async markRead(id: string, recipientId: string): Promise<MarkReadOutcome> {
    return this.prisma.write.$transaction(async (tx) => {
      const row = await tx.notification.findFirst({
        where: { id, recipientId },
        select: { id: true, readAt: true },
      });
      if (!row) return 'notFound';
      if (!row.readAt) {
        await tx.notification.update({ where: { id }, data: { readAt: new Date() } });
      }
      return 'ok';
    });
  }

  /**
   * Marca TODAS las no leídas del destinatario como leídas (solo la BANDEJA = canal PUSH; SMS/WEBHOOK
   * no se leen en la app). Filtra `readAt: null` para no re-sellar las ya leídas. Devuelve cuántas
   * marcó. Servido por @@index([recipientId, channel, createdAt]) (prefijo recipient+channel).
   */
  async markAllRead(recipientId: string): Promise<number> {
    const { count } = await this.prisma.write.notification.updateMany({
      where: { recipientId, channel: NotificationChannel.PUSH, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }

  async findDue(now: Date, limit: number): Promise<NotificationRecord[]> {
    const rows = await this.prisma.write.notification.findMany({
      where: { status: NotificationStatus.PENDING, nextAttemptAt: { lte: now } },
      // Prioridad PRIMERO (mayor = más urgente): el pánico (Critical) nunca espera detrás de un broadcast
      // (Bulk). A igual prioridad, FIFO por antigüedad. Servido por @@index([status, priority, nextAttemptAt]).
      orderBy: [{ priority: 'desc' }, { nextAttemptAt: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async markSent(
    id: string,
    args: { to: string; channel: NotificationChannel; attempts: number },
  ): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      await tx.notification.update({
        where: { id },
        data: {
          // Honesto: SENT = el riel aceptó. `deliveredAt` queda NULL hasta que exista un receipt real.
          status: NotificationStatus.SENT,
          attempts: args.attempts,
          sentAt: new Date(),
          nextAttemptAt: null,
          failedReason: null,
        },
      });
      const envelope = createEnvelope({
        eventType: 'notification.sent',
        producer: 'notification-service',
        payload: { notificationId: id, channel: args.channel, to: args.to },
      });
      await enqueueOutbox(tx, envelope, id);
    });
  }

  async markFailed(
    id: string,
    args: { channel: NotificationChannel; reason: string; attempts: number },
  ): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      await tx.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.FAILED,
          attempts: args.attempts,
          nextAttemptAt: null,
          failedReason: args.reason,
        },
      });
      const envelope = createEnvelope({
        eventType: 'notification.failed',
        producer: 'notification-service',
        payload: { notificationId: id, channel: args.channel, error: args.reason },
      });
      await enqueueOutbox(tx, envelope, id);
    });
  }

  /**
   * Derecho al olvido (Ley 29733, BR-S06): purga el HISTORIAL del destinatario Y su COLA pendiente
   * (las filas PENDING son la cola del worker: borrarlas es des-encolar). En la MISMA transacción
   * borra las filas del outbox derivadas de esas notificaciones (`aggregateId` = id de la notificación):
   * sus envelopes notification.sent/failed llevan el destino `to` (token/teléfono) → PII. Idempotente
   * (deleteMany/relay con updateMany: la carrera con el drain no rompe). NO forma parte del puerto
   * NotificationStore: es capacidad de borrado del repositorio, no del motor de envío.
   */
  async eraseByRecipients(recipientIds: string[]): Promise<number> {
    if (recipientIds.length === 0) return 0;
    return this.prisma.write.$transaction(async (tx) => {
      const rows = await tx.notification.findMany({
        where: { recipientId: { in: recipientIds } },
        select: { id: true },
      });
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
      const { count } = await tx.notification.deleteMany({ where: { id: { in: ids } } });
      return count;
    });
  }

  async scheduleRetry(
    id: string,
    args: { attempts: number; nextAttemptAt: Date; reason: string },
  ): Promise<void> {
    await this.prisma.write.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.PENDING,
        attempts: args.attempts,
        nextAttemptAt: args.nextAttemptAt,
        failedReason: args.reason,
      },
    });
  }
}
