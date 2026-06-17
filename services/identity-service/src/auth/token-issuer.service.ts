/**
 * TokenIssuerService — emisión centralizada de tokens (ADR-012, hardening auth).
 * Crea la sesión en Redis (RedisRefreshTokenStore) y firma el par access+refresh JWT ES256.
 * Único punto de emisión: AuthService (teléfono+OTP) y EmailAuthService (correo+contraseña)
 * delegan acá para no duplicar la lógica de sesión+firma.
 */
import { Injectable } from '@nestjs/common';
import { JwtService, RedisRefreshTokenStore, type SubjectType } from '@veo/auth';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class TokenIssuerService {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: RedisRefreshTokenStore,
  ) {}

  /** Crea sesión + firma access/refresh para `userId`. `user` es el bloque público devuelto al cliente. */
  async issue(userId: string, typ: SubjectType, user: AuthTokens['user']): Promise<AuthTokens> {
    const { sessionId, newJti } = await this.sessions.createSession(userId);
    const accessToken = await this.jwt.signAccessToken({
      sub: userId,
      typ,
      roles: [],
      sid: sessionId,
    });
    const refreshToken = await this.jwt.signRefreshToken({
      sub: userId,
      sid: sessionId,
      jti: newJti,
      typ,
    });
    return { accessToken, refreshToken, user };
  }
}
