/**
 * NotificationsService — capa de aplicación sobre el motor: encola y consulta notificaciones.
 * No contiene lógica de entrega (vive en el motor); solo orquesta y mapea a vistas seguras.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import { NotificationEngine } from '../engine/notification.engine';
import { NotificationRepository } from '../engine/notification.repository';
import { TemplateService } from '../engine/template.service';
import { categoryForTemplate } from '../engine/template.catalog';
import type { NotificationRecord } from '../engine/types';
import type {
  CreateNotificationDto,
  InboxNotificationView,
  NotificationView,
} from './dto/notification.dto';

function toView(rec: NotificationRecord, deduped?: boolean): NotificationView {
  return {
    id: rec.id,
    recipientId: rec.recipientId,
    channel: rec.channel,
    template: rec.template,
    status: rec.status,
    attempts: rec.attempts,
    maxAttempts: rec.maxAttempts,
    dedupKey: rec.dedupKey,
    nextAttemptAt: rec.nextAttemptAt?.toISOString() ?? null,
    sentAt: rec.sentAt?.toISOString() ?? null,
    deliveredAt: rec.deliveredAt?.toISOString() ?? null,
    failedReason: rec.failedReason,
    createdAt: rec.createdAt.toISOString(),
    ...(deduped !== undefined ? { deduped } : {}),
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly engine: NotificationEngine,
    private readonly repo: NotificationRepository,
    private readonly templates: TemplateService,
  ) {}

  async enqueue(dto: CreateNotificationDto): Promise<NotificationView> {
    const payload: Record<string, unknown> = { ...(dto.payload ?? {}), to: dto.to };
    const { notification, deduped } = await this.engine.enqueue({
      recipientId: dto.recipientId,
      channel: dto.channel,
      template: dto.template,
      payload,
      dedupKey: dto.dedupKey,
      maxAttempts: dto.maxAttempts,
    });
    return toView(notification, deduped);
  }

  async getById(id: string): Promise<NotificationView> {
    const rec = await this.repo.findById(id);
    if (!rec) throw new NotFoundError(`Notificación '${id}' no encontrada`);
    return toView(rec);
  }

  async listByRecipient(recipientId: string, limit = 50): Promise<NotificationView[]> {
    const rows = await this.repo.findByRecipient(recipientId, Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => toView(r));
  }

  /**
   * BANDEJA in-app del usuario: notificaciones PUSH ya renderizadas (título + cuerpo del template)
   * y categorizadas. Carga las plantillas en UNA query (sin N+1) y arma la vista que ve el usuario.
   */
  async listInbox(recipientId: string, limit = 30): Promise<InboxNotificationView[]> {
    const rows = await this.repo.findInboxByRecipient(
      recipientId,
      Math.min(Math.max(limit, 1), 100),
    );
    const tpls = await this.templates.loadTemplatesByKeys(rows.map((r) => r.template));
    return rows.map((rec) => {
      const { title, body } = this.templates.renderInbox(rec, tpls.get(rec.template));
      return {
        id: rec.id,
        category: categoryForTemplate(rec.template),
        title,
        body,
        createdAt: rec.createdAt.toISOString(),
      };
    });
  }
}
