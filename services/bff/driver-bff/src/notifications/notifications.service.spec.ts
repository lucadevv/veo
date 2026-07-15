/**
 * Tests del mark-read de Avisos del conductor (GAP: el driver-bff no proxyaba la lectura y la app
 * hardcodeaba `read=true`):
 *  - markRead proxya PATCH /notifications/:id/read con la identidad firmada (owner del downstream);
 *  - el id va URL-encoded (un id hostil no rompe/reescribe la ruta);
 *  - markAllRead proxya PATCH /notifications/read-all y devuelve el conteo del motor.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { NotificationsService } from './notifications.service';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

function makeService(patchReply: unknown = undefined) {
  const patch = vi.fn(() => Promise.resolve(patchReply));
  const client = { patch, get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  const rest = { client: vi.fn(() => client) };
  const service = new NotificationsService(rest as never);
  return { service, rest, patch };
}

describe('NotificationsService (driver-bff) — mark-read proxyado a notification-service', () => {
  it('markRead PATCHea /notifications/:id/read con la identidad propagada (anti-IDOR downstream)', async () => {
    const { service, rest, patch } = makeService();

    await service.markRead(identity, 'ntf-1');

    expect(rest.client).toHaveBeenCalledWith('notification');
    expect(patch).toHaveBeenCalledWith('/notifications/ntf-1/read', { identity });
  });

  it('markRead URL-encodea el id (un id hostil no reescribe la ruta)', async () => {
    const { service, patch } = makeService();

    await service.markRead(identity, 'a/b?x=1');

    expect(patch).toHaveBeenCalledWith('/notifications/a%2Fb%3Fx%3D1/read', { identity });
  });

  it('markAllRead PATCHea /notifications/read-all y devuelve el conteo del motor', async () => {
    const { service, patch } = makeService({ updated: 4 });

    const result = await service.markAllRead(identity);

    expect(patch).toHaveBeenCalledWith('/notifications/read-all', { identity });
    expect(result).toEqual({ updated: 4 });
  });
});
