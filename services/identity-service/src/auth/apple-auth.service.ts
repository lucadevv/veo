/**
 * AppleAuthService — login con Sign in with Apple SOBERANO (ADR-012 §4, espejo de GoogleAuthService).
 * Apple es OBLIGATORIO por App Store Guideline 4.8 al ofrecer Google. Verificamos el identityToken
 * de Apple NOSOTROS contra su JWKS (puerto OAUTH_VERIFIER), sin SaaS de terceros. Lo ÚNICO propio
 * de Apple es esa verificación + el mapeo de claims; la resolución de identidad y la emisión de
 * tokens viven UNA vez en OAuthLoginService (Lote A2).
 *
 * Particularidades de Apple frente a Google:
 *  - El email solo viaja en el PRIMER login (relay privado @privaterelay.appleid.com posible). En
 *    logins posteriores no viene; el lookup por `sub` del flujo compartido resuelve el re-login
 *    sin email.
 *  - El nombre NUNCA viaja en el token (Apple lo entrega aparte solo la 1ra vez) → name=null.
 */
import { Inject, Injectable } from '@nestjs/common';
import { OAuthLoginService } from './oauth-login.service';
import { OAUTH_VERIFIER, type OAuthVerifier } from '../ports/oauth/oauth.port';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class AppleAuthService {
  constructor(
    @Inject(OAUTH_VERIFIER) private readonly verifier: OAuthVerifier,
    private readonly oauthLogin: OAuthLoginService,
  ) {}

  /**
   * Login con Apple. Verifica el identityToken (firma+iss+aud+exp vía puerto) y delega el resto al
   * flujo OAuth compartido. Token inválido → 401 (lo lanza el verificador).
   */
  async loginWithApple(identityToken: string): Promise<AuthTokens> {
    const { sub, email, emailVerified } = await this.verifier.verifyAppleIdToken(identityToken);
    return this.oauthLogin.login({
      methodType: 'APPLE_OAUTH',
      sub,
      email,
      emailVerified,
      // Apple no manda el nombre en el token → el User nuevo nace con name=null.
      name: null,
      invalidTokenMessage: 'token de Apple inválido',
    });
  }
}
