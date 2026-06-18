import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalServiceError, RateLimitError } from '@veo/utils';
import { TwilioSmsSender } from './twilio-client';

const ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const AUTH_TOKEN = 'tok_secret';
const FROM = '+15005550006';

function makeSender(over: Partial<ConstructorParameters<typeof TwilioSmsSender>[0]> = {}): TwilioSmsSender {
  return new TwilioSmsSender({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    from: FROM,
    timeoutMs: 5_000,
    ...over,
  });
}

/** Captura la última llamada a fetch para inspeccionar URL/headers/body. */
function stubFetch(impl: (url: string, init: RequestInit) => Response): {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(impl(url, init));
  });
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('TwilioSmsSender · construcción del request', () => {
  it('POSTea a la URL oficial con Basic auth y form To/From/Body; 201 → ok', async () => {
    const { calls } = stubFetch(() => new Response('{"sid":"SM1","status":"queued"}', { status: 201 }));
    await makeSender().send('+51987654321', 'Tu código VEO es 482913');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
    );
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('To')).toBe('+51987654321');
    expect(body.get('From')).toBe(FROM);
    expect(body.get('Body')).toBe('Tu código VEO es 482913');
    // El '+' viaja url-encoded como %2B.
    expect(init.body as string).toContain('To=%2B51987654321');
  });

  it('con MessagingServiceSid usa ese campo en vez de From', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 201 }));
    await makeSender({ from: undefined, messagingServiceSid: 'MGzzzz' }).send('+51900000000', 'x 123456');
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get('MessagingServiceSid')).toBe('MGzzzz');
    expect(body.get('From')).toBeNull();
  });

  it('4xx no-429 → ExternalServiceError (502, NO reintentable como rate limit)', async () => {
    stubFetch(() => new Response('{"code":21211,"message":"Invalid To"}', { status: 400 }));
    await expect(makeSender().send('+51987654321', 'x 123456')).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it('429 → RateLimitError (reintentable)', async () => {
    stubFetch(() => new Response('{"code":20429,"message":"Too Many Requests"}', { status: 429 }));
    await expect(makeSender().send('+51987654321', 'x 123456')).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('code 20429 con status 4xx → también RateLimitError', async () => {
    stubFetch(() => new Response('{"code":20429,"message":"throttled"}', { status: 400 }));
    await expect(makeSender().send('+51987654321', 'x 123456')).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('error de red → ExternalServiceError sin filtrar el teléfono completo', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNRESET')));
    const err = await makeSender().send('+51987654321', 'secreto 123456').catch((e) => e);
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as Error).message).not.toContain('+51987654321');
    expect((err as Error).message).not.toContain('123456'); // nunca el Body
    expect((err as Error).message).toContain('•••4321');
  });
});
