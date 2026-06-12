/**
 * GoogleAuthService — login con Google OAuth SOBERANO (ADR-012 §4, Lote 3).
 * Verificamos el id_token de Google NOSOTROS contra su JWKS (puerto OAUTH_VERIFIER), sin SaaS de
 * terceros. Lo ÚNICO propio de Google es esa verificación + el mapeo de claims; la resolución de
 * identidad (re-login por sub, linking por correo verificado, alta nueva + outbox user.registered)
 * y la emisión de tokens viven UNA vez en OAuthLoginService (Lote A2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { OAuthLoginService } from './oauth-login.service';
import { OAUTH_VERIFIER, type OAuthVerifier } from '../ports/oauth/oauth.port';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class GoogleAuthService {
  constructor(
    @Inject(OAUTH_VERIFIER) private readonly verifier: OAuthVerifier,
    private readonly oauthLogin: OAuthLoginService,
  ) {}

  /**
   * Login con Google. Verifica el id_token (firma+iss+aud+exp vía puerto) y delega el resto al
   * flujo OAuth compartido. Token inválido → 401 (lo lanza el verificador).
   */
  async loginWithGoogle(idToken: string): Promise<AuthTokens> {
    const { sub, email, emailVerified, name } = await this.verifier.verifyGoogleIdToken(idToken);
    return this.oauthLogin.login({
      methodType: 'GOOGLE_OAUTH',
      sub,
      email,
      emailVerified,
      // Google sí manda el nombre del perfil en el id_token.
      name,
      invalidTokenMessage: 'token de Google inválido',
    });
  }
}
