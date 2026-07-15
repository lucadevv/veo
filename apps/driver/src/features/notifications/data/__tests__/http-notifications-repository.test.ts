import type { HttpClient } from '@veo/api-client';
import type { ZodType } from 'zod';
import { HttpNotificationsRepository } from '../repositories/http-notifications-repository';

interface Call {
  method: string;
  path: string;
  opts: Record<string, unknown> | undefined;
}

type Handler = (method: string, path: string) => unknown;

/**
 * Doble mínimo del HttpClient: registra las llamadas, responde lo que diga el handler y APLICA el
 * schema Zod si la llamada lo trae (mismo contrato que el HttpClient real, que parsea la respuesta).
 */
class FakeHttpClient {
  calls: Call[] = [];
  constructor(private readonly handler: Handler = () => undefined) {}
  get(path: string, opts?: Record<string, unknown>) {
    return this.run('GET', path, opts);
  }
  patch(path: string, opts?: Record<string, unknown>) {
    return this.run('PATCH', path, opts);
  }
  private async run(method: string, path: string, opts?: Record<string, unknown>) {
    this.calls.push({ method, path, opts });
    const result = this.handler(method, path);
    const schema = opts?.schema as ZodType<unknown> | undefined;
    return schema ? schema.parse(result) : result;
  }
}

const asHttp = (h: FakeHttpClient): HttpClient => h as unknown as HttpClient;

/** Aviso del inbox RENDERIZADO tal cual lo entrega el driver-bff (proxy de /notifications/inbox). */
const INBOX_ITEM = {
  id: 'ntf-1',
  category: 'payment',
  title: 'Tu liquidación se procesó',
  body: 'Tu liquidación va en camino a tu billetera.',
  createdAt: '2026-07-15T12:00:00.000Z',
  read: false,
};

describe('HttpNotificationsRepository (driver) — inbox renderizado + mark-read real', () => {
  it('lista la bandeja mapeando category→kind y HONRANDO el read real del server', async () => {
    const fake = new FakeHttpClient(() => [
      INBOX_ITEM,
      { ...INBOX_ITEM, id: 'ntf-2', category: 'trip', read: true },
    ]);
    const repo = new HttpNotificationsRepository(asHttp(fake));

    const items = await repo.getNotifications(30);

    expect(fake.calls[0]).toMatchObject({ method: 'GET', path: '/notifications' });
    expect(items).toEqual([
      {
        id: 'ntf-1',
        kind: 'RECEIPT',
        title: INBOX_ITEM.title,
        body: INBOX_ITEM.body,
        createdAt: INBOX_ITEM.createdAt,
        // Ya NO se hardcodea true: el borde de acento / punto de la campana usan este valor real.
        read: false,
      },
      expect.objectContaining({ id: 'ntf-2', kind: 'TRIP', read: true }),
    ]);
  });

  it('markRead PATCHea /notifications/:id/read', async () => {
    const fake = new FakeHttpClient();
    const repo = new HttpNotificationsRepository(asHttp(fake));

    await repo.markRead('ntf-1');

    expect(fake.calls[0]).toMatchObject({ method: 'PATCH', path: '/notifications/ntf-1/read' });
  });

  it('markAllRead PATCHea /notifications/read-all', async () => {
    const fake = new FakeHttpClient(() => ({ updated: 3 }));
    const repo = new HttpNotificationsRepository(asHttp(fake));

    await repo.markAllRead();

    expect(fake.calls[0]).toMatchObject({ method: 'PATCH', path: '/notifications/read-all' });
  });

  it('rechaza una respuesta que no cumple el contrato del inbox (schema compartido)', async () => {
    // La vista OPERACIONAL vieja (template key, sin title/body) YA NO se tolera: el shim degradado
    // por template se eliminó cuando el BFF apuntó al inbox renderizado.
    const fake = new FakeHttpClient(() => [{ id: 'ntf-1', template: 'driver.approved' }]);
    const repo = new HttpNotificationsRepository(asHttp(fake));

    await expect(repo.getNotifications()).rejects.toThrow();
  });
});
