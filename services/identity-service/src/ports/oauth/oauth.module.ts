/**
 * Módulo del puerto OAUTH (ADR-012 Lote 3). Provee OAUTH_VERIFIER seleccionando implementación
 * por VEO_OAUTH_MODE: sandbox (dev/CI/tests, sin tokens reales de Google) o live (verificación
 * soberana contra el JWKS de Google con jose). El JWKS se cachea (createRemoteJWKSet ya cachea).
 */
import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { UnauthorizedError } from '@veo/utils';
import {
  OAUTH_VERIFIER,
  type AppleIdentity,
  type GoogleIdentity,
  type OAuthVerifier,
} from './oauth.port';
import type { Env } from '../../config/env.schema';

/** JWKS oficial de Google (discovery: https://accounts.google.com/.well-known/openid-configuration). */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Emisores válidos del id_token de Google (ambas formas son oficiales). */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** JWKS oficial de Apple (Sign in with Apple). */
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** Emisor válido del identityToken de Apple. */
const APPLE_ISSUER = 'https://appleid.apple.com';
/** Bundle ID por defecto de la passenger app (aud del flujo nativo Sign in with Apple). */
const APPLE_DEFAULT_CLIENT_ID = 'pe.veo.passenger';

/** Claims del id_token de Google que leemos tras verificar firma+iss+aud+exp con jose. */
interface GoogleTokenPayload {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

/** Claims del identityToken de Apple que leemos tras verificar firma+iss+aud+exp con jose. */
interface AppleTokenPayload {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

/**
 * Sandbox determinista (VEO_OAUTH_MODE=sandbox, dev/CI/tests). NO verifica firma: decodifica el
 * idToken como un JSON en base64url plano del payload de fixture {sub,email,email_verified,name}.
 * Permite probar el flujo de login con Google sin emitir tokens reales del IdP. NO es un mock de
 * tests: cualquiera puede construir un fixture base64url y ejercitar el camino feliz/infeliz.
 */
export class OAuthSandboxVerifier implements OAuthVerifier {
  private readonly logger = new Logger('OAuthSandbox');

  async verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
    let payload: GoogleTokenPayload;
    try {
      const json = Buffer.from(idToken, 'base64url').toString('utf8');
      payload = JSON.parse(json) as GoogleTokenPayload;
    } catch {
      throw new UnauthorizedError('token de Google inválido');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('token de Google inválido');
    }
    this.logger.warn(`[SANDBOX OAUTH] aceptando id_token de fixture para sub=${payload.sub}`);
    return mapPayload(payload);
  }

  async verifyAppleIdToken(identityToken: string): Promise<AppleIdentity> {
    let payload: AppleTokenPayload;
    try {
      const json = Buffer.from(identityToken, 'base64url').toString('utf8');
      payload = JSON.parse(json) as AppleTokenPayload;
    } catch {
      throw new UnauthorizedError('token de Apple inválido');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('token de Apple inválido');
    }
    this.logger.warn(`[SANDBOX OAUTH] aceptando identityToken de fixture para sub=${payload.sub}`);
    return mapApplePayload(payload);
  }
}

/**
 * Live: verificación SOBERANA contra el JWKS de Google. jose valida firma (JWKS) + iss + aud + exp;
 * luego leemos sub/email/email_verified/name del payload. El JWKS remoto se cachea internamente.
 */
export class GoogleOAuthVerifier {
  private readonly jwks: JWTVerifyGetKey;

  /** @param clientIds GOOGLE_CLIENT_ID por plataforma (iOS/Android/Web): cualquiera es `aud` válido. */
  constructor(private readonly clientIds: string[]) {
    this.jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }

  async verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
    let payload: GoogleTokenPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: this.clientIds,
      }));
    } catch {
      // jose distingue firma/iss/aud/exp, pero al cliente le devolvemos un 401 uniforme.
      throw new UnauthorizedError('token de Google inválido');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('token de Google inválido');
    }
    return mapPayload(payload);
  }
}

/**
 * Live: verificación SOBERANA contra el JWKS de Apple (Sign in with Apple). jose valida firma
 * (JWKS) + iss (`https://appleid.apple.com`) + aud (Bundle ID, flujo nativo) + exp; luego leemos
 * sub/email/email_verified. El `name` NO viene en el token (Apple lo entrega aparte solo la 1ra vez).
 */
export class AppleOAuthVerifier {
  private readonly jwks: JWTVerifyGetKey;

  /** @param clientIds APPLE_CLIENT_ID (Bundle IDs): cualquiera es `aud` válido del flujo nativo. */
  constructor(private readonly clientIds: string[]) {
    this.jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }

  async verifyAppleIdToken(identityToken: string): Promise<AppleIdentity> {
    let payload: AppleTokenPayload;
    try {
      ({ payload } = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.clientIds,
      }));
    } catch {
      // jose distingue firma/iss/aud/exp, pero al cliente le devolvemos un 401 uniforme.
      throw new UnauthorizedError('token de Apple inválido');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('token de Apple inválido');
    }
    return mapApplePayload(payload);
  }
}

/**
 * Live: compone los verificadores soberanos por proveedor (Google + Apple) en un único puerto
 * OAuthVerifier. Cada uno cachea su propio JWKS remoto. El dominio sigue dependiendo del Symbol.
 */
export class LiveOAuthVerifier implements OAuthVerifier {
  constructor(
    private readonly google: GoogleOAuthVerifier,
    private readonly apple: AppleOAuthVerifier,
  ) {}

  verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
    return this.google.verifyGoogleIdToken(idToken);
  }

  verifyAppleIdToken(identityToken: string): Promise<AppleIdentity> {
    return this.apple.verifyAppleIdToken(identityToken);
  }
}

/** Normaliza el payload crudo (claims opcionales) al contrato del puerto. */
function mapPayload(payload: GoogleTokenPayload): GoogleIdentity {
  return {
    sub: payload.sub as string,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}

/**
 * Normaliza el payload crudo de Apple al contrato del puerto. `email_verified` puede venir como
 * bool o string "true". `email` puede faltar (Apple solo lo manda en el 1er login) → null. `name`
 * nunca viaja en el token → siempre null.
 */
function mapApplePayload(payload: AppleTokenPayload): AppleIdentity {
  return {
    sub: payload.sub as string,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: null,
  };
}

/** GOOGLE_CLIENT_ID / APPLE_CLIENT_ID son listas separadas por coma (una entrada por plataforma). */
function parseClientIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const oauthProvider: Provider = {
  provide: OAUTH_VERIFIER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): OAuthVerifier => {
    if (config.getOrThrow<string>('VEO_OAUTH_MODE') !== 'live') {
      return new OAuthSandboxVerifier();
    }
    const googleClientIds = parseClientIds(config.get<string>('GOOGLE_CLIENT_ID'));
    if (googleClientIds.length === 0) {
      throw new Error('VEO_OAUTH_MODE=live requiere GOOGLE_CLIENT_ID (lista separada por coma)');
    }
    // APPLE_CLIENT_ID = Bundle ID(s) de la app (flujo nativo). Default `pe.veo.passenger`.
    const appleClientIds = parseClientIds(config.get<string>('APPLE_CLIENT_ID'));
    const appleAudiences = appleClientIds.length > 0 ? appleClientIds : [APPLE_DEFAULT_CLIENT_ID];
    return new LiveOAuthVerifier(
      new GoogleOAuthVerifier(googleClientIds),
      new AppleOAuthVerifier(appleAudiences),
    );
  },
};

@Module({ providers: [oauthProvider], exports: [OAUTH_VERIFIER] })
export class OAuthModule {}
