/**
 * Tests del derecho al olvido (BR-S06, Ley 29733) en notification-service:
 *  - NotificationRepository.eraseByRecipients purga historial + cola pendiente + outbox derivado.
 *  - UserDeletedConsumer purga tokens, notificaciones y tickets al recibir user.deleted,
 *    valida el payload y deduplica por eventId (dedup DESPUÉS del éxito → un fallo reintenta).
 *
 * Estilo media/chat: clases construidas directamente con dobles, sin Nest DI.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@veo/events';
import { NotificationRepository } from '../engine/notification.repository';
import { UserDeletedConsumer } from './user-deleted.consumer';
import type { DeviceTokenRepository } from '../devices/device-token.repository';
import type { SupportTicketRepository } from '../support/support.repository';
import type { NotificationPreferenceRepository } from '../notification-prefs/notification-prefs.repository';
import type { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  KAFKA_BROKERS: 'localhost:9094',
} as Partial<Env> as Env);

/** Redis en memoria (solo get/set) para deduplicación. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    },
  };
}

function envelope(payload: unknown, eventId = 'evt-1'): EventEnvelope<unknown> {
  return {
    eventId,
    eventType: 'user.deleted',
    occurredAt: '2026-06-10T00:00:00.000Z',
    producer: 'identity-service',
    schemaVersion: 1,
    payload,
  };
}

describe('NotificationRepository.eraseByRecipients (derecho al olvido)', () => {
  function makeSpyPrisma(notificationIds: string[]) {
    const deletes: { model: string; where: Record<string, unknown> }[] = [];
    const tx = {
      notification: {
        findMany: vi.fn(async () => notificationIds.map((id) => ({ id }))),
        deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          deletes.push({ model: 'notification', where: args.where });
          return { count: notificationIds.length };
        }),
      },
      outboxEvent: {
        deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          deletes.push({ model: 'outboxEvent', where: args.where });
          return { count: notificationIds.length };
        }),
      },
    };
    const prisma = {
      write: { $transaction: async <R>(fn: (t: unknown) => Promise<R>): Promise<R> => fn(tx) },
    } as unknown as PrismaService;
    return { prisma, deletes, tx };
  }

  it('borra el outbox derivado (aggregateId = id de la notificación) Y las notificaciones, en ese orden', async () => {
    const { prisma, deletes } = makeSpyPrisma(['n1', 'n2']);
    const repo = new NotificationRepository(prisma);

    const count = await repo.eraseByRecipients(['usr-1', 'drv-9']);

    expect(count).toBe(2);
    expect(deletes).toEqual([
      { model: 'outboxEvent', where: { aggregateId: { in: ['n1', 'n2'] } } },
      { model: 'notification', where: { id: { in: ['n1', 'n2'] } } },
    ]);
  });

  it('sin notificaciones del destinatario → no toca el outbox y devuelve 0 (idempotente)', async () => {
    const { prisma, deletes } = makeSpyPrisma([]);
    const repo = new NotificationRepository(prisma);

    const count = await repo.eraseByRecipients(['usr-sin-nada']);

    expect(count).toBe(0);
    expect(deletes).toHaveLength(0);
  });
});

describe('UserDeletedConsumer', () => {
  function makeConsumer() {
    const devices = { deleteByUser: vi.fn(async () => 2) };
    const notifications = { eraseByRecipients: vi.fn(async () => 5) };
    const tickets = { deleteByUser: vi.fn(async () => 1) };
    const prefs = { deleteByUser: vi.fn(async () => 1) };
    const redis = makeRedis();
    const consumer = new UserDeletedConsumer(
      devices as unknown as DeviceTokenRepository,
      notifications as unknown as NotificationRepository,
      tickets as unknown as SupportTicketRepository,
      prefs as unknown as NotificationPreferenceRepository,
      redis as never,
      config,
    );
    const invoke = (e: EventEnvelope<unknown>) =>
      (
        consumer as unknown as {
          onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
        }
      ).onUserDeleted(e);
    return { consumer, devices, notifications, tickets, prefs, invoke };
  }

  it('purga tokens push, notificaciones (historial + cola), tickets y preferencias al recibir user.deleted', async () => {
    const { devices, notifications, tickets, prefs, invoke } = makeConsumer();

    await invoke(envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' }));

    expect(devices.deleteByUser).toHaveBeenCalledWith('usr-1');
    expect(notifications.eraseByRecipients).toHaveBeenCalledWith(['usr-1']);
    expect(tickets.deleteByUser).toHaveBeenCalledWith('usr-1');
    expect(prefs.deleteByUser).toHaveBeenCalledWith('usr-1');
  });

  it('si la identidad era conductor, purga también las notificaciones dirigidas a su driverId', async () => {
    const { notifications, invoke } = makeConsumer();

    await invoke(envelope({ userId: 'usr-1', driverId: 'drv-9', at: '2026-06-10T00:00:00.000Z' }));

    expect(notifications.eraseByRecipients).toHaveBeenCalledWith(['usr-1', 'drv-9']);
  });

  it('ignora payloads inválidos sin borrar nada (no lanza)', async () => {
    const { devices, notifications, tickets, prefs, invoke } = makeConsumer();

    await invoke(envelope({ nope: true }));

    expect(devices.deleteByUser).not.toHaveBeenCalled();
    expect(notifications.eraseByRecipients).not.toHaveBeenCalled();
    expect(tickets.deleteByUser).not.toHaveBeenCalled();
    expect(prefs.deleteByUser).not.toHaveBeenCalled();
  });

  it('deduplica por eventId: reprocesar el mismo evento NO vuelve a purgar', async () => {
    const { devices, invoke } = makeConsumer();
    const evt = envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await invoke(evt);
    await invoke(evt);

    expect(devices.deleteByUser).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si la purga falla (permite reintento de kafkajs)', async () => {
    const { notifications, invoke } = makeConsumer();
    let calls = 0;
    notifications.eraseByRecipients.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('Postgres caído');
      return 5;
    });
    const evt = envelope({ userId: 'usr-1', at: '2026-06-10T00:00:00.000Z' });

    await expect(invoke(evt)).rejects.toThrow('Postgres caído');
    // El reintento (mismo eventId) ahora sí debe ejecutarse y tener éxito.
    await invoke(evt);

    expect(calls).toBe(2);
  });
});
