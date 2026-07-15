import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError, ValidationError } from '@veo/utils';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  verifyInternalIdentity,
} from '@veo/auth';
import { NotificationSmsSender } from './notification-sms-sender';

const SECRET = 'test-internal-secret';
const BASE_URL = 'http://notification.local/api/v1';
const PHONE = '+51987654321';
const MESSAGE = 'Tu código de verificación de contacto VEO es 482913 (válido 5 min).';

/**
 * Construye un fetch espía que captura la request y devuelve una respuesta con el status/cuerpo dado.
 * El adaptador habla con notification-service a través del InternalRestClient canónico, así que
 * mockeamos `globalThis.fetch` (el cliente lo usa por defecto) y verificamos el contrato HTTP real:
 * path, body y la identidad FIRMADA (HMAC) que el InternalIdentityGuard de notification verificará.
 */
function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
  return impl;
}

describe('NotificationSmsSender (share-service)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTea /notifications con template contact.otp, payload.code, teléfono destino y prioridad Critical', async () => {
    const fetchSpy = stubFetch(202, { id: 'ntf_1', status: 'PENDING' });
    const sender = new NotificationSmsSender(BASE_URL, SECRET);

    await sender.send(PHONE, MESSAGE);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://notification.local/api/v1/notifications');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      recipientId: PHONE,
      channel: 'SMS',
      template: 'contact.otp',
      to: PHONE,
      payload: { code: '482913' },
      priority: 100,
    });
    // dedupKey deriva del teléfono + el código (un OTP nuevo = clave nueva → no se dedup-ea).
    expect(body['dedupKey']).toBe(`otp:${PHONE}:482913`);
  });

  it('firma la identidad interna (HMAC) que notification verificará con el secreto compartido', async () => {
    const fetchSpy = stubFetch(202, { id: 'ntf_1', status: 'PENDING' });
    const sender = new NotificationSmsSender(BASE_URL, SECRET);

    await sender.send(PHONE, MESSAGE);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const header = headers[INTERNAL_IDENTITY_HEADER];
    const signature = headers[INTERNAL_IDENTITY_SIG_HEADER];
    expect(header).toBeTruthy();
    expect(signature).toBeTruthy();

    // La firma debe verificar con el MISMO secreto (lo que hará el InternalIdentityGuard server-side).
    const identity = verifyInternalIdentity(header!, signature!, SECRET);
    expect(identity).not.toBeNull();
    // share-service NO es un servicio de conductor: el principal sintético es 'passenger', no 'driver'.
    expect(identity?.type).toBe('passenger');
    expect(identity?.userId).toBe('anonymous');
    // Lo que GATEA la llamada es la audiencia de riel de SISTEMA.
    expect(identity?.aud).toBe('service-rail');
  });

  it('lanza ValidationError (NO transitorio) si el mensaje no contiene un código de 6 dígitos', async () => {
    const fetchSpy = stubFetch(202, { id: 'ntf_1', status: 'PENDING' });
    const sender = new NotificationSmsSender(BASE_URL, SECRET);

    await expect(sender.send(PHONE, 'mensaje sin codigo')).rejects.toBeInstanceOf(ValidationError);
    // Falla ANTES de tocar la red: no es un fallo reintentable de notification.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mapea un non-2xx de notification a un error de dominio tipado (no 500 opaco)', async () => {
    stubFetch(502, { code: 'EXTERNAL', message: 'upstream down' });
    const sender = new NotificationSmsSender(BASE_URL, SECRET);

    await expect(sender.send(PHONE, MESSAGE)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('envuelve un fallo de red/timeout en ExternalServiceError (502 reintentable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const sender = new NotificationSmsSender(BASE_URL, SECRET, 5);

    await expect(sender.send(PHONE, MESSAGE)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
