import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalServiceError, RateLimitError, ValidationError } from '@veo/utils';
import { WhatsAppCloudSender, extractOtpCode } from './whatsapp-client';

const PHONE_NUMBER_ID = '123456789';
const ACCESS_TOKEN = 'EAAtoken_secret';

function makeSender(): WhatsAppCloudSender {
  return new WhatsAppCloudSender({
    phoneNumberId: PHONE_NUMBER_ID,
    accessToken: ACCESS_TOKEN,
    otpTemplate: 'veo_otp',
    otpLang: 'es',
    graphVersion: 'v25.0',
    timeoutMs: 5_000,
  });
}

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

describe('extractOtpCode · DEUDA de extracción', () => {
  it('extrae el código de 6 dígitos de la frase renderizada', () => {
    expect(extractOtpCode('Tu código VEO es 482913. No lo compartas.')).toBe('482913');
  });
  it('sin código de 6 dígitos → ValidationError (no transitorio)', () => {
    expect(() => extractOtpCode('mensaje sin codigo')).toThrow(ValidationError);
  });
});

describe('WhatsAppCloudSender · construcción del request', () => {
  it('POSTea a la URL v25.0 con Bearer y body de plantilla con el código en body+botón', async () => {
    const { calls } = stubFetch(() => new Response('{"messages":[{"id":"wamid.X"}]}', { status: 200 }));
    await makeSender().send('+51987654321', 'Tu código VEO es 482913');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.recipient_type).toBe('individual');
    expect(body.to).toBe('+51987654321');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('veo_otp');
    expect(body.template.language).toEqual({ code: 'es' });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      {
        type: 'button',
        sub_type: 'copy_code',
        index: '0',
        parameters: [{ type: 'text', text: '482913' }],
      },
    ]);
  });

  it('200 con messages[] → ok', async () => {
    stubFetch(() => new Response('{"messages":[{"id":"wamid.X","message_status":"accepted"}]}', { status: 200 }));
    await expect(makeSender().send('+51900000000', 'codigo 654321')).resolves.toBeUndefined();
  });

  it('envelope de error de Graph 4xx → ExternalServiceError', async () => {
    stubFetch(
      () =>
        new Response(
          '{"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"fbtrace_id":"A"}}',
          { status: 400 },
        ),
    );
    await expect(makeSender().send('+51900000000', 'codigo 654321')).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it('429 → RateLimitError (reintentable)', async () => {
    stubFetch(() => new Response('{"error":{"message":"rate","code":130429}}', { status: 429 }));
    await expect(makeSender().send('+51900000000', 'codigo 654321')).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('code de cuota de Meta (131048) en 4xx → RateLimitError', async () => {
    stubFetch(() => new Response('{"error":{"message":"limit","code":131048}}', { status: 400 }));
    await expect(makeSender().send('+51900000000', 'codigo 654321')).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('error no expone el teléfono completo ni el código', async () => {
    stubFetch(() => new Response('{"error":{"message":"boom","code":100}}', { status: 400 }));
    const err = await makeSender().send('+51987654321', 'Tu código VEO es 482913').catch((e) => e);
    expect((err as Error).message).not.toContain('+51987654321');
    expect((err as Error).message).not.toContain('482913');
    expect((err as Error).message).toContain('•••4321');
  });
});
