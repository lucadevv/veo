/**
 * Denylist de sesiones en Redis COMPARTIDO (cross-instancia) — enforcement server-side de la revocación.
 *
 * PROBLEMA (causa raíz): el access token JWT es stateless (firma ES256 + 15m de vida). Verificar la
 * firma NO detecta que la sesión fue revocada (single-session: otro login la superó; logout; suspensión).
 * Sin este denylist, un token revocado seguía siendo válido hasta 15m → app ZOMBIE.
 *
 * MECANISMO (dos ejes, uno por primitiva de revocación — cada una mapea a su denylist natural):
 *  1. `revoked:sid:{sid}`            — set por `revokeSession(sid)` (logout, reuse detection). Revoca UNA
 *     sesión concreta. Necesario porque el logout NO debe tumbar las OTRAS sesiones del user
 *     (p. ej. pasajero multi-device): un eje user-level lo haría, un eje por-sid es exacto.
 *  2. `revoked:before:{userId}` = iat — set por `revokeAllForUser(userId)` (single-session del conductor,
 *     suspensión). Revoca TODAS las sesiones emitidas ANTES de ahora de un golpe: el token NUEVO (emitido
 *     DESPUÉS del revoke, iat mayor) pasa; los viejos (iat menor) se rechazan. Un solo key, auto-limpia.
 *
 * Ambos ejes viven en el MISMO Redis que el refresh-store (cross-instancia por diseño): identity ESCRIBE
 * al revocar, los BFFs LEEN en el camino de auth (guard HTTP + handshake del socket).
 *
 * DEGRADACIÓN (fail-OPEN documentada): si Redis no responde dentro de {@link CHECK_TIMEOUT_MS}, el check
 * degrada al baseline pre-existente (token válido hasta su `exp`, ≤15m) en vez de desloguear a TODA la
 * flota mid-viaje por un blip de Redis. Ver {@link SessionRevocationStore.isRevoked}.
 */
import type { Redis } from 'ioredis';
import { UnauthorizedError } from '@veo/utils';

/** Motivo TIPADO del rechazo por revocación (cero strings mágicos aguas arriba). */
export type SessionRevocationReason =
  /** El `sid` concreto fue revocado (logout explícito o reuse detection del refresh). */
  | 'session-revoked'
  /** Todas las sesiones del user emitidas antes del `iat` fueron revocadas (revokeAllForUser). */
  | 'sessions-superseded';

/**
 * Error TIPADO: la sesión del token está revocada. Extiende `UnauthorizedError` (httpStatus 401) para que
 * el filtro de excepciones del BFF devuelva 401 automáticamente (→ el cliente HTTP refresca, el refresh
 * falla porque la sesión ya no existe en el refresh-store, y desloguea). El handshake del socket lo cacha
 * para rechazar con un `connect_error` de motivo explícito.
 */
export class SessionRevokedError extends UnauthorizedError {
  constructor(readonly revocationReason: SessionRevocationReason) {
    super('Sesión revocada');
  }
}

/** Claims mínimos que la verificación de revocación necesita del access token. */
export interface RevocableClaims {
  /** userId (claim `sub`). */
  sub: string;
  /** sessionId (claim `sid`). */
  sid: string;
  /** epoch en SEGUNDOS de emisión (claim `iat`). Ausente = el eje "revoked-before" no puede evaluarse. */
  iat?: number;
}

/**
 * Vida del access token (FOUNDATION §7, regla #5: "Access 15m"). El denylist se auto-limpia a esta vida +
 * un margen de skew: un token emitido en el instante del revoke expira en `iat+ACCESS_TTL`, así que la
 * entrada del denylist debe cubrir hasta ahí para no dejar un hueco.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_MARGIN_SECONDS = 60;
/** TTL de las entradas del denylist: cubre la vida completa del último token revocable + skew. */
export const REVOCATION_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_MARGIN_SECONDS;

/**
 * Techo del check contra Redis. `@veo/redis` usa `maxRetriesPerRequest: null` (reintenta INDEFINIDO ante
 * un blip), así que SIN este timeout el request colgaría durante un outage. Al vencer → fail-open.
 */
const CHECK_TIMEOUT_MS = 150;

const KEY_PREFIX = 'veo:revoked:';
const revokedSessionKey = (sid: string): string => `${KEY_PREFIX}sid:${sid}`;
const revokedBeforeKey = (userId: string): string => `${KEY_PREFIX}before:${userId}`;

/** Subset mínimo de logger (compatible con `@veo/observability` y NestJS Logger). No acopla a un framework. */
export interface RevocationLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Store del denylist de revocación. Una única clase concentra el esquema de keys, el TTL, el fail-open y
 * la observabilidad (SRP). identity la usa para ESCRIBIR (vía RedisRefreshTokenStore), los BFFs para LEER.
 */
export class SessionRevocationStore {
  constructor(
    private readonly redis: Redis,
    private readonly logger?: RevocationLogger,
    /** TTL de las entradas (solo relevante en las escrituras). Default = vida del access token + skew. */
    private readonly ttlSeconds: number = REVOCATION_TTL_SECONDS,
  ) {}

  /**
   * ESCRITURA — revoca UN `sid` (logout, reuse detection). El access token de esa sesión se rechaza al
   * instante en el próximo check. Best-effort: la sesión ya se borró del refresh-store; si el denylist
   * falla, el token sobrevive hasta su `exp` (baseline pre-Lote-1). Log ruidoso (regla #6), NO rompe logout.
   */
  async revokeSession(sid: string): Promise<void> {
    try {
      await this.redis.set(revokedSessionKey(sid), '1', 'EX', this.ttlSeconds);
    } catch (err) {
      this.logger?.warn({ err, sid }, 'session-revocation: fallo al escribir denylist por-sid');
    }
  }

  /**
   * ESCRITURA — revoca TODAS las sesiones del user emitidas ANTES de ahora (single-session del conductor,
   * suspensión). Sella `revoked:before:{userId} = nowSec`. El token NUEVO (iat ≥ now) pasa; los viejos no.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      await this.redis.set(revokedBeforeKey(userId), String(nowSec), 'EX', this.ttlSeconds);
    } catch (err) {
      this.logger?.warn({ err, userId }, 'session-revocation: fallo al escribir revoked-before');
    }
  }

  /**
   * LECTURA — ¿está revocado este token? Devuelve el motivo tipado o `null`. Un solo round-trip (MGET de
   * ambos ejes). Fail-OPEN ante error/timeout de Redis (ver doc de módulo): degradar al baseline (≤15m) es
   * preferible a desloguear a toda la flota por un parpadeo; cada request RE-evalúa, así el hueco es
   * transitorio (nunca permanente).
   */
  async isRevoked(claims: RevocableClaims): Promise<SessionRevocationReason | null> {
    try {
      const [sidRaw, beforeRaw] = await this.withTimeout(
        this.redis.mget(revokedSessionKey(claims.sid), revokedBeforeKey(claims.sub)),
      );
      if (sidRaw != null) return 'session-revoked';
      if (beforeRaw != null && claims.iat != null) {
        const revokedBefore = Number(beforeRaw);
        // STRICT `<`: un token emitido en el MISMO segundo (o después) del revoke SOBREVIVE. Así el token
        // NUEVO del single-session —revoke→emit dentro del mismo segundo, `iat` floored a segundos por
        // jose— pasa. Residual (documentado): un token VIEJO acuñado en el mismísimo segundo del revoke
        // sobrevive; requiere dos logins en el mismo segundo (mismo humano) → despreciable.
        if (Number.isFinite(revokedBefore) && claims.iat < revokedBefore) return 'sessions-superseded';
      }
      return null;
    } catch (err) {
      this.logger?.warn(
        { err, sid: claims.sid },
        'session-revocation: check indisponible → fail-open (degradado al baseline ≤15m)',
      );
      return null;
    }
  }

  /** Lanza {@link SessionRevokedError} si el token está revocado; no-op si está vigente (o fail-open). */
  async assertNotRevoked(claims: RevocableClaims): Promise<void> {
    const reason = await this.isRevoked(claims);
    if (reason) throw new SessionRevokedError(reason);
  }

  /**
   * Corre la promesa contra un techo de {@link CHECK_TIMEOUT_MS}. `Promise.race` adjunta reacciones a AMBAS
   * promesas, así que un rechazo TARDÍO del comando Redis (tras ganar el timeout) queda "manejado" → sin
   * unhandledRejection. Limpia el timer siempre.
   */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('session-revocation check timeout')),
        CHECK_TIMEOUT_MS,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
