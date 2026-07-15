/**
 * Tests de preferencias in-app (SEAM prefs):
 *  - GET sin fila → defaults canónicos (nunca 404).
 *  - GET con fila → la fila persistida.
 *  - PUT roundtrip: upsert con el objeto completo y devuelve lo persistido.
 *
 * Estilo support.service.spec: la clase se construye con un doble del repo, sin Nest DI.
 */
import { describe, it, expect } from 'vitest';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  NotificationPreferenceRepository,
  type NotificationPrefsInput,
} from './notification-prefs.repository';
import { DEFAULT_NOTIFICATION_PREFS } from './dto/notification-prefs.dto';
import type { NotificationPreference } from '../generated/prisma';

function row(userId: string, prefs: NotificationPrefsInput): NotificationPreference {
  return {
    userId,
    ...prefs,
    createdAt: new Date('2026-07-11T00:00:00Z'),
    updatedAt: new Date('2026-07-11T00:00:00Z'),
  };
}

function makeService() {
  const store = new Map<string, NotificationPreference>();
  const repo: Pick<NotificationPreferenceRepository, 'findByUser' | 'upsert'> = {
    findByUser: async (userId) => store.get(userId) ?? null,
    upsert: async (userId, prefs) => {
      const r = row(userId, prefs);
      store.set(userId, r);
      return r;
    },
  };
  return new NotificationPrefsService(repo as NotificationPreferenceRepository);
}

describe('NotificationPrefsService', () => {
  it('GET sin fila devuelve los defaults canónicos (nunca 404)', async () => {
    const service = makeService();
    const prefs = await service.get('usr-nuevo');
    expect(prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('PUT persiste el objeto completo y GET lo devuelve (roundtrip)', async () => {
    const service = makeService();
    const desired: NotificationPrefsInput = {
      tripStatus: true,
      driverEnRoute: false,
      scheduledReminders: false,
      offers: true,
      news: false,
    };

    const putResult = await service.put('usr-1', desired);
    expect(putResult).toEqual(desired);

    const getResult = await service.get('usr-1');
    expect(getResult).toEqual(desired);
  });
});
