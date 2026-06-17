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
  /**
   * Email del sujeto. SOLO se emite para operadores (`typ === 'admin'`): son staff interno y su
   * identidad legible es parte de la rendición de cuentas (watermark de video BR-S02, audit). NUNCA
   * se incluye para pasajero/conductor — su email/PII no viaja en el token. Ausente = no disponible.
   */
  email?: string;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  /** id rotativo de este refresh concreto (para detección de reuse) */
  jti: string;
  /**
   * Tipo de sujeto del refresh token. Permite que `refresh` repueble la autorización desde la tabla
   * correcta (admin → AdminUser; passenger/driver → User) y re-emita el access con roles/email frescos.
   * El refresh NO porta autorización (roles/email): solo identifica DÓNDE re-leerla. `undefined` en
   * tokens emitidos antes de este cambio (backward-compat: `refresh` cae a un lookup por tanteo).
   */
  typ?: SubjectType;
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
  /**
   * Email del operador, propagado desde el claim `email` del access token (solo `type === 'admin'`).
   * Fuente legible de identidad para el watermark de video (BR-S02) y la rendición de cuentas. Ausente
   * para pasajero/conductor y para tokens de admin re-emitidos por refresh (ese camino no porta email).
   */
  email?: string;
}

/**
 * Request HTTP con la identidad autenticada adjunta por los guards (JwtAuthGuard en los BFFs,
 * InternalIdentityGuard en los microservicios). FUENTE ÚNICA del contrato: los guards derivados
 * (driver-type, admin-identity, etc.) la importan de aquí en vez de redeclararla localmente.
 */
export interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
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
    // `email` se incluye solo si viene seteado (operadores). Omitirlo cuando es undefined evita
    // un claim `email: null` ruidoso en tokens de pasajero/conductor.
    const payload: JWTPayload = {
      typ: claims.typ,
      roles: claims.roles,
      sid: claims.sid,
      mfaAt: claims.mfaAt,
    };
    if (claims.email !== undefined) payload.email = claims.email;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: JWT_ALG })
      .setSubject(claims.sub)
      .setIssuer(this.keys.issuer)
      .setAudience(this.keys.audience)
      .setIssuedAt()
      .setExpirationTime(this.keys.accessTtl)
      .sign(await this.getPrivate());
  }

  async signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
    // `typ` se incluye solo si viene seteado. Identifica el tipo de sujeto para que el refresh
    // repueble la autorización desde la tabla correcta. NO se firman roles/email en el refresh.
    const payload: JWTPayload = { sid: claims.sid };
    if (claims.typ !== undefined) payload.typ = claims.typ;
    return new SignJWT(payload)
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
      email: payload.email as string | undefined,
    };
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    const payload = await this.verify(token);
    if (!payload.sub || !payload.jti) throw new UnauthorizedError('refresh token incompleto');
    return {
      sub: payload.sub,
      sid: payload.sid as string,
      jti: payload.jti,
      // `undefined` para refresh tokens emitidos antes de portar `typ` (backward-compat).
      typ: payload.typ as SubjectType | undefined,
    };
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
    email: claims.email,
  };
}
