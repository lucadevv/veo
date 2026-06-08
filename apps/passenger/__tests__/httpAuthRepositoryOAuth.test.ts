import {
  type HttpClient,
  appleAuthTokens,
  googleAuthTokens,
} from '@veo/api-client';
import { HttpAuthRepository } from '../src/features/auth/data/httpAuthRepository';

/**
 * Fake mínimo del HttpClient: capturamos cada POST para verificar ruta, body y schema.
 * El repo es passthrough tipado contra el public-bff (/auth/oauth/*) — sin mocks de negocio.
 */
function makeHttp(response: unknown) {
  const post = jest.fn(async () => response);
  const http = { post } as unknown as HttpClient;
  return { http, post };
}

const TOKENS_RESPONSE = {
  accessToken: 'access.jwt',
  refreshToken: 'refresh.jwt',
  user: { id: 'u-1', phone: null, type: 'passenger', kycStatus: 'PENDING', email: 'ana@veo.pe' },
};

describe('HttpAuthRepository · login social nativo (OAuth)', () => {
  it('loginWithGoogle hace POST /auth/oauth/google con el idToken y devuelve tokens validados', async () => {
    const { http, post } = makeHttp(TOKENS_RESPONSE);
    const repo = new HttpAuthRepository(http);

    const tokens = await repo.loginWithGoogle({ idToken: 'google.id.token' });

    expect(post).toHaveBeenCalledWith('/auth/oauth/google', {
      body: { idToken: 'google.id.token' },
      schema: googleAuthTokens,
    });
    expect(tokens).toEqual(TOKENS_RESPONSE);
  });

  it('loginWithApple hace POST /auth/oauth/apple con el identityToken y devuelve tokens validados', async () => {
    const { http, post } = makeHttp(TOKENS_RESPONSE);
    const repo = new HttpAuthRepository(http);

    const tokens = await repo.loginWithApple({ identityToken: 'apple.identity.token' });

    expect(post).toHaveBeenCalledWith('/auth/oauth/apple', {
      body: { identityToken: 'apple.identity.token' },
      schema: appleAuthTokens,
    });
    expect(tokens).toEqual(TOKENS_RESPONSE);
  });
});
