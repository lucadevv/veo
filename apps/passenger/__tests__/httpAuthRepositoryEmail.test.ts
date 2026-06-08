import {
  type HttpClient,
  emailForgotResult,
  emailRegisterResult,
  emailResendResult,
  emailResetResult,
  mobileAuthTokens,
} from '@veo/api-client';
import { HttpAuthRepository } from '../src/features/auth/data/httpAuthRepository';

/**
 * Fake mínimo del HttpClient: capturamos cada POST para verificar ruta, body y schema.
 * El repo es passthrough tipado contra el public-bff (/auth/email/*) — sin mocks de negocio.
 */
function makeHttp(response: unknown = { sent: true }) {
  const post = jest.fn(async () => response);
  const http = { post } as unknown as HttpClient;
  return { http, post };
}

const TOKENS_RESPONSE = {
  accessToken: 'access.jwt',
  refreshToken: 'refresh.jwt',
  user: { id: 'u-1', phone: null, type: 'passenger', kycStatus: 'PENDING', email: 'ana@veo.pe' },
};

describe('HttpAuthRepository · correo + contraseña (ADR-012)', () => {
  it('registerEmail hace POST /auth/email/register con el body y el schema {sent:true}', async () => {
    const { http, post } = makeHttp({ sent: true });
    const repo = new HttpAuthRepository(http);

    const result = await repo.registerEmail({
      email: 'ana@veo.pe',
      password: 'unaClaveSegura123',
      name: 'Ana',
      type: 'PASSENGER',
    });

    expect(post).toHaveBeenCalledWith('/auth/email/register', {
      body: { email: 'ana@veo.pe', password: 'unaClaveSegura123', name: 'Ana', type: 'PASSENGER' },
      schema: emailRegisterResult,
    });
    expect(result).toEqual({ sent: true });
  });

  it('resendEmailCode hace POST /auth/email/resend con el schema {sent:true} (anti-enumeración)', async () => {
    const { http, post } = makeHttp({ sent: true });
    const repo = new HttpAuthRepository(http);

    const result = await repo.resendEmailCode({ email: 'ana@veo.pe' });

    expect(post).toHaveBeenCalledWith('/auth/email/resend', {
      body: { email: 'ana@veo.pe' },
      schema: emailResendResult,
    });
    expect(result).toEqual({ sent: true });
  });

  it('verifyEmail hace POST /auth/email/verify y devuelve tokens validados', async () => {
    const { http, post } = makeHttp(TOKENS_RESPONSE);
    const repo = new HttpAuthRepository(http);

    const tokens = await repo.verifyEmail({ email: 'ana@veo.pe', code: '123456' });

    expect(post).toHaveBeenCalledWith('/auth/email/verify', {
      body: { email: 'ana@veo.pe', code: '123456' },
      schema: mobileAuthTokens,
    });
    expect(tokens).toEqual(TOKENS_RESPONSE);
  });

  it('loginEmail hace POST /auth/email/login y devuelve tokens validados', async () => {
    const { http, post } = makeHttp(TOKENS_RESPONSE);
    const repo = new HttpAuthRepository(http);

    const tokens = await repo.loginEmail({ email: 'ana@veo.pe', password: 'unaClaveSegura123' });

    expect(post).toHaveBeenCalledWith('/auth/email/login', {
      body: { email: 'ana@veo.pe', password: 'unaClaveSegura123' },
      schema: mobileAuthTokens,
    });
    expect(tokens).toEqual(TOKENS_RESPONSE);
  });

  it('forgotPassword hace POST /auth/email/forgot con el schema {sent:true}', async () => {
    const { http, post } = makeHttp({ sent: true });
    const repo = new HttpAuthRepository(http);

    const result = await repo.forgotPassword({ email: 'ana@veo.pe' });

    expect(post).toHaveBeenCalledWith('/auth/email/forgot', {
      body: { email: 'ana@veo.pe' },
      schema: emailForgotResult,
    });
    expect(result).toEqual({ sent: true });
  });

  it('resetPassword hace POST /auth/email/reset con el schema {ok:true}', async () => {
    const { http, post } = makeHttp({ ok: true });
    const repo = new HttpAuthRepository(http);

    const result = await repo.resetPassword({
      email: 'ana@veo.pe',
      code: '654321',
      newPassword: 'otraClaveSegura123',
    });

    expect(post).toHaveBeenCalledWith('/auth/email/reset', {
      body: { email: 'ana@veo.pe', code: '654321', newPassword: 'otraClaveSegura123' },
      schema: emailResetResult,
    });
    expect(result).toEqual({ ok: true });
  });
});
