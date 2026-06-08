/**
 * Firma y verificación de JWT con ES256 (ECDSA P-256) vía jose.
 * Access 15m, refresh 30d (FOUNDATION §7). Claves asimétricas: identity-service firma con la
 * privada; quien valida (BFF) usa la pública.
 */
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type JWTPayload, type KeyLike } from 'jose';
import { UnauthorizedError } from '@veo/utils';
import type { AdminRole } from '@veo/shared-types';

export const JWT_ALG = 'ES256' as const;

export type SubjectType = 'passenger' | 'driver' | 'admin';

export interface AccessTokenClaims {
  /** userId */
  sub: string;
  typ: SubjectType;
  roles: AdminRole[];
  /** sessionId (familia de refresh tokens) */
  sid: string;
  /** epoch (s) de la última verificación MFA fresca, para step-up (BR-S07) */
  mfaAt?: number;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  /** id rotativo de este refresh concreto (para detección de reuse) */
  jti: string;
}

export interface AuthenticatedUser {
  userId: string;
  type: SubjectType;
  roles: AdminRole[];
  sessionId: string;
  mfaVerifiedAt?: number;
  /**
   * driverId resuelto (userId→driver) por el BFF para identidades de conductor.
   * NO viene del JWT: el BFF lo resuelve vía identity (GetDriverByUser) y lo firma en la
   * identidad interna (HMAC), de modo que los servicios pueden verificar propiedad sin confiar
   * en un driverId arbitrario del query param (anti-IDOR). Ausente para passenger/admin.
   */
  driverId?: string;
  /**
   * El pasajero pasó la verificación de identidad (KYC liveness → kycStatus VERIFIED). NO viene del
   * JWT: el BFF lo resuelve vía identity (GetUser) y lo firma en la identidad interna (HMAC), de modo
   * que el servicio-de-registro (trip-service) puede EXIGIRLO sin confiar en un flag del cliente
   * (defensa en profundidad del gate KYC, igual que driverId lo es para anti-IDOR). Ausente/false = no verificado.
   */
  kycVerified?: boolean;
}

export interface JwtKeys {
  privatePem: string; // PKCS8
  publicPem: string; // SPKI
  issuer: string;
  audience: string;
  accessTtl: string; // '15m'
  refreshTtl: string; // '30d'
}

export class JwtService {
  private privateKey?: KeyLike;
  private publicKey?: KeyLike;

  constructor(private readonly keys: JwtKeys) {}

  private async getPrivate(): Promise<KeyLike> {
    this.privateKey ??= await importPKCS8(this.keys.privatePem, JWT_ALG);
    return this.privateKey;
  }
  private async getPublic(): Promise<KeyLike> {
    this.publicKey ??= await importSPKI(this.keys.publicPem, JWT_ALG);
    return this.publicKey;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ typ: claims.typ, roles: claims.roles, sid: claims.sid, mfaAt: claims.mfaAt })
      .setProtectedHeader({ alg: JWT_ALG })
      .setSubject(claims.sub)
      .setIssuer(this.keys.issuer)
      .setAudience(this.keys.audience)
      .setIssuedAt()
      .setExpirationTime(this.keys.accessTtl)
      .sign(await this.getPrivate());
  }

  async signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: JWT_ALG })
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuer(this.keys.issuer)
      .setAudience(this.keys.audience)
      .setIssuedAt()
      .setExpirationTime(this.keys.refreshTtl)
      .sign(await this.getPrivate());
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    const payload = await this.verify(token);
    if (!payload.sub) throw new UnauthorizedError('token sin subject');
    return {
      sub: payload.sub,
      typ: payload.typ as SubjectType,
      roles: (payload.roles as AdminRole[] | undefined) ?? [],
      sid: payload.sid as string,
      mfaAt: payload.mfaAt as number | undefined,
    };
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    const payload = await this.verify(token);
    if (!payload.sub || !payload.jti) throw new UnauthorizedError('refresh token incompleto');
    return { sub: payload.sub, sid: payload.sid as string, jti: payload.jti };
  }

  private async verify(token: string): Promise<JWTPayload & Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(token, await this.getPublic(), {
        issuer: this.keys.issuer,
        audience: this.keys.audience,
      });
      return payload;
    } catch {
      throw new UnauthorizedError('Token inválido o expirado');
    }
  }
}

/**
 * Genera un par de claves ES256 en PEM. Útil en dev/test cuando no hay claves provistas por env.
 * En producción las claves vienen de Secrets Manager (NO generar efímeras en prod).
 */
export async function generateDevKeyPairPem(): Promise<{ privatePem: string; publicPem: string }> {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair(JWT_ALG);
  return { privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) };
}

export function toAuthenticatedUser(claims: AccessTokenClaims): AuthenticatedUser {
  return {
    userId: claims.sub,
    type: claims.typ,
    roles: claims.roles,
    sessionId: claims.sid,
    mfaVerifiedAt: claims.mfaAt,
  };
}
