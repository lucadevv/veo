/**
 * Tests de la bandeja in-app (SEAM read/unread):
 *  - listInbox DERIVA `read` de `read_at` (ya no lo inventa el cliente).
 *  - markRead sella la lectura del dueño; un id ajeno/inexistente → NotFound (anti-IDOR).
 *  - markAllRead devuelve cuántas marcó.
 *
 * Estilo support.service.spec: la clase se construye con dobles, sin Nest DI.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@veo/utils';
import { NotificationChannel, NotificationStatus } from '@veo/shared-types';
import { NotificationsService } from './notifications.service';
import type { NotificationEngine } from '../engine/notification.engine';
import type { NotificationRepository, MarkReadOutcome } from '../engine/notification.repository';
import type { TemplateService } from '../engine/template.service';
import type { NotificationRecord } from '../engine/types';

function record(over: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'n1',
    recipientId: 'usr-1',
    channel: NotificationChannel.PUSH,
    template: 'trip.assigned',
    payload: {},
    status: NotificationStatus.SENT,
    priority: 0,
    dedupKey: null,
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    sentAt: new Date('2026-07-10T10:00:00Z'),
    deliveredAt: null,
    failedReason: null,
    readAt: null,
    createdAt: new Date('2026-07-10T10:00:00Z'),
    ...over,
  };
}

const engineStub = {} as NotificationEngine;
const templatesStub = {
  loadTemplatesByKeys: vi.fn(async () => new Map()),
  renderInbox: vi.fn(() => ({ title: 'Título', body: 'Cuerpo' })),
} as unknown as TemplateService;

describe('NotificationsService · bandeja read/unread', () => {
  it('listInbox deriva read=true cuando readAt != null y false cuando es null', async () => {
    const repo = {
      findInboxByRecipient: vi.fn(async () => [
        record({ id: 'leida', readAt: new Date('2026-07-10T11:00:00Z') }),
        record({ id: 'nueva', readAt: null }),
      ]),
    } as unknown as NotificationRepository;
    const service = new NotificationsService(engineStub, repo, templatesStub);

    const inbox = await service.listInbox('usr-1');

    expect(inbox.find((n) => n.id === 'leida')?.read).toBe(true);
    expect(inbox.find((n) => n.id === 'nueva')?.read).toBe(false);
  });

  it('markRead sella la lectura del dueño (ok)', async () => {
    const markRead = vi.fn(async (): Promise<MarkReadOutcome> => 'ok');
    const repo = { markRead } as unknown as NotificationRepository;
    const service = new NotificationsService(engineStub, repo, templatesStub);

    await expect(service.markRead('usr-1', 'n1')).resolves.toBeUndefined();
    expect(markRead).toHaveBeenCalledWith('n1', 'usr-1');
  });

  it('markRead de una notificación ajena/inexistente → NotFound (anti-IDOR)', async () => {
    const repo = {
      markRead: vi.fn(async (): Promise<MarkReadOutcome> => 'notFound'),
    } as unknown as NotificationRepository;
    const service = new NotificationsService(engineStub, repo, templatesStub);

    await expect(service.markRead('atacante', 'n1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('markAllRead devuelve cuántas marcó', async () => {
    const markAllRead = vi.fn(async () => 4);
    const repo = { markAllRead } as unknown as NotificationRepository;
    const service = new NotificationsService(engineStub, repo, templatesStub);

    const res = await service.markAllRead('usr-1');

    expect(res).toEqual({ updated: 4 });
    expect(markAllRead).toHaveBeenCalledWith('usr-1');
  });
});
