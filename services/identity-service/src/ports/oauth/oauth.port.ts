/**
 * Puerto OAUTH (FOUNDATION §9, ADR-012 Lote 3). Verificación SOBERANA del id_token de Google:
 * validamos firma + iss + aud + exp NOSOTROS contra el JWKS de Google (sin Auth0/Firebase).
 * El dominio (GoogleAuthService) depende de ESTE Symbol, nunca de jose ni del proveedor concreto.
 * Selección por VEO_OAUTH_MODE (sandbox|live).
 */

/** Claims mínimos que el dominio necesita de un id_token de Google ya verificado. */
export interface GoogleIdentity {
  /** `sub` de Google: identificador estable del usuario en el IdP (PK del vínculo OAuth). */
  sub: string;
  email: string | null;
  /** `email_verified` de Google: solo vinculamos por email si es true (seguridad de account-linking). */
  emailVerified: boolean;
  name: string | null;
}

/**
 * Claims mínimos que el dominio necesita de un identityToken de Apple (Sign in with Apple) ya
 * verificado. Espejo de GoogleIdentity, con dos particularidades de Apple:
 *  - `email` solo viene en el PRIMER login (después puede no venir); por eso es opcional/null.
 *  - el `name` NUNCA viaja en el token (Apple lo entrega aparte, solo la 1ra vez) → siempre null acá.
 */
export interface AppleIdentity {
  /** `sub` de Apple: identificador estable del usuario en el IdP (PK del vínculo OAuth). */
  sub: string;
  email: string | null;
  /** `email_verified` de Apple: solo vinculamos por email si es true (seguridad de account-linking). */
  emailVerified: boolean;
  /** Apple no manda el nombre en el token → siempre null (se mantiene por simetría con Google). */
  name: string | null;
}

export const OAUTH_VERIFIER = Symbol('OAUTH_VERIFIER');

export interface OAuthVerifier {
  /**
   * Verifica un id_token de Google (firma + iss + aud + exp) y devuelve los claims relevantes.
   * Lanza UnauthorizedError si el token es inválido (firma/iss/aud/exp/forma).
   */
  verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity>;

  /**
   * Verifica un identityToken de Apple (firma + iss + aud + exp) y devuelve los claims relevantes.
   * Lanza UnauthorizedError si el token es inválido (firma/iss/aud/exp/forma).
   */
  verifyAppleIdToken(identityToken: string): Promise<AppleIdentity>;
}
