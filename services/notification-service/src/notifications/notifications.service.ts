/**
 * NotificationsService — capa de aplicación sobre el motor: encola y consulta notificaciones.
 * No contiene lógica de entrega (vive en el motor); solo orquesta y mapea a vistas seguras.
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import { NotificationEngine } from '../engine/notification.engine';
import { NotificationRepository } from '../engine/notification.repository';
import { TemplateService } from '../engine/template.service';
import { categoryForTemplate } from '../engine/template.catalog';
import { InboxReadScope, bumpInboxRead } from '../metrics/notification.metrics';
import type { NotificationRecord } from '../engine/types';
import type {
  CreateNotificationDto,
  InboxNotificationView,
  MarkAllReadResultView,
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
  private readonly logger = new Logger(NotificationsService.name);

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
      priority: dto.priority,
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
        // read DERIVADO server-side: el cliente ya no lo inventa (antes hardcodeaba true).
        read: rec.readAt != null,
      };
    });
  }

  /**
   * Marca UNA notificación como leída. `recipientId` viene de la identidad de sesión (anti-IDOR): el
   * caller nunca elige de quién es. Si no existe o no es del usuario → NotFound (no revela ajenas).
   */
  async markRead(recipientId: string, id: string): Promise<void> {
    const outcome = await this.repo.markRead(id, recipientId);
    if (outcome === 'notFound') {
      throw new NotFoundError(`Notificación '${id}' no encontrada`);
    }
    bumpInboxRead(InboxReadScope.Single);
    this.logger.log(`Notificación ${id} marcada como leída (recipient=${recipientId})`);
  }

  /** Marca TODAS las no leídas de la bandeja (PUSH) del usuario. Devuelve cuántas marcó. */
  async markAllRead(recipientId: string): Promise<MarkAllReadResultView> {
    const updated = await this.repo.markAllRead(recipientId);
    bumpInboxRead(InboxReadScope.All, updated);
    this.logger.log(`read-all: ${updated} notificación(es) marcadas (recipient=${recipientId})`);
    return { updated };
  }
}
