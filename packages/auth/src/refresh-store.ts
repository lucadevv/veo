/**
 * Refresh tokens con ROTACIÓN + store en Redis (decisión cliente).
 * - Cada refresh emite uno nuevo e invalida el anterior (jti rotativo).
 * - Revocable al instante: borrar la sesión mata todas sus credenciales (suspender conductor BR-D01,
 *   logout remoto, pánico).
 * - Reuse detection: si llega un jti ya rotado, es robo de token → se mata toda la familia (sesión).
 */
import type { Redis } from 'ioredis';
import { uuidv7 } from '@veo/utils';
import type { SessionRevocationStore } from './session-revocation.js';

export interface SessionRecord {
  userId: string;
  /** jti del refresh token actualmente válido para esta sesión */
  currentJti: string;
  createdAt: number;
}

export interface RotationResult {
  sessionId: string;
  newJti: string;
}

export class RedisRefreshTokenStore {
  constructor(
    private readonly redis: Redis,
    /** TTL de la sesión en segundos (= refresh TTL, ej. 30d) */
    private readonly ttlSeconds: number,
    /**
     * Denylist de revocación (enforcement server-side del access token, stateless). Al borrar la sesión
     * del refresh-store, se sella la entrada del denylist para que el access token de esa sesión (aún con
     * firma válida hasta 15m) se rechace al instante en los BFFs. OPCIONAL solo para poder testear la
     * rotación en aislamiento; en producción SIEMPRE se cablea (identity CoreModule).
     */
    private readonly revocation?: SessionRevocationStore,
    private readonly prefix = 'veo:session:',
    /**
     * Prefix del ÍNDICE SECUNDARIO por-usuario: `veo:user-sessions:{userId}` es un SET de sessionIds. Es la
     * única forma de enumerar las sesiones de UN user sin barrer todo el keyspace `veo:session:*` (que era
     * O(N global de TODOS los users) en el hot-path de login single-session + suspensión). Mismo patrón de
     * prefix tipado que `prefix`: cero strings mágicos, override-able por DI/tests.
     */
    private readonly userIndexPrefix = 'veo:user-sessions:',
  ) {}

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  /** Key del índice secundario (SET de sessionIds) de un usuario. */
  private userSessionsKey(userId: string): string {
    return `${this.userIndexPrefix}${userId}`;
  }

  /**
   * Crea una sesión nueva (login). Devuelve sessionId + jti inicial.
   *
   * Además del record de la sesión, indexa el sid en el SET `veo:user-sessions:{userId}` para que
   * `revokeAllForUser` lo enumere en O(sesiones-del-user) en vez de barrer el keyspace global.
   *
   * TTL del índice — EXPIRE SLIDING = ttlSeconds (refresh, 30d) en CADA SADD: cada sesión nueva refresca el
   * vencimiento del SET a `now + ttlSeconds`. Como toda sesión-miembro vive a lo sumo `ttlSeconds` desde su
   * creación, y el SADD más reciente empuja el EXPIRE del SET a `now + ttlSeconds`, el SET SIEMPRE sobrevive
   * a su miembro más nuevo (nunca desaparece un índice mientras exista una sesión viva que indexa) y se
   * AUTO-LIMPIA `ttlSeconds` después de la última sesión → el índice no crece sin techo. Un fijo (EXPIRE
   * solo al crear el SET) dejaría el índice venciendo ANTES que su última sesión → sids vivos huérfanos.
   *
   * Pipeline `multi()` (mismo idiom que dispatch/redis-offer-board): SET + SADD + EXPIRE en un round-trip,
   * así el login no paga 3 RTTs. No requiere atomicidad transaccional fuerte: el record de la sesión es la
   * fuente de verdad y un sid stale en el índice es tolerable (ver `revokeAllForUser`).
   */
  async createSession(userId: string): Promise<RotationResult> {
    const sessionId = uuidv7();
    const newJti = uuidv7();
    const record: SessionRecord = { userId, currentJti: newJti, createdAt: Date.now() };
    const pipeline = this.redis.multi();
    pipeline.set(this.key(sessionId), JSON.stringify(record), 'EX', this.ttlSeconds);
    pipeline.sadd(this.userSessionsKey(userId), sessionId);
    pipeline.expire(this.userSessionsKey(userId), this.ttlSeconds);
    await pipeline.exec();
    return { sessionId, newJti };
  }

  /**
   * Rota el refresh. Valida que el jti presentado sea el vigente.
   * - jti vigente → emite nuevo jti, persiste, devuelve.
   * - jti no vigente pero la sesión existe → REUSE: token robado → mata la sesión, lanza.
   * - sesión inexistente → revocada/expirada → lanza.
   */
  async rotate(sessionId: string, presentedJti: string): Promise<RotationResult> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) throw new RefreshError('SESSION_REVOKED');
    const record = JSON.parse(raw) as SessionRecord;
    if (record.currentJti !== presentedJti) {
      await this.revoke(sessionId); // reuse detection → mata familia completa
      throw new RefreshError('TOKEN_REUSE_DETECTED');
    }
    const newJti = uuidv7();
    record.currentJti = newJti;
    await this.redis.set(this.key(sessionId), JSON.stringify(record), 'EX', this.ttlSeconds);
    return { sessionId, newJti };
  }

  /** Revoca una sesión (logout, suspensión). Idempotente. Sella el denylist por-sid (enforcement stateless). */
  async revoke(sessionId: string): Promise<void> {
    // GET antes del DEL para conocer el userId y poder limpiar el índice secundario (el sid solo no lo
    // revela). Si el record ya no existe (revocado/expirado), no hay índice que limpiar → staleness
    // tolerable (un sid huérfano en el SET es no-op al borrar en `revokeAllForUser`). No es hot-path.
    const raw = await this.redis.get(this.key(sessionId));
    await this.redis.del(this.key(sessionId));
    if (raw) {
      const { userId } = JSON.parse(raw) as SessionRecord;
      await this.redis.srem(this.userSessionsKey(userId), sessionId);
    }
    // Mata el access token de esta sesión al instante (no espera a su exp de 15m).
    await this.revocation?.revokeSession(sessionId);
  }

  /**
   * Revoca todas las sesiones de un usuario. Usa el ÍNDICE SECUNDARIO `veo:user-sessions:{userId}` →
   * O(sesiones-del-user), NO O(N global de TODOS los users) como el `scanStream('veo:session:*')` anterior
   * (que barría el keyspace entero en el hot-path de login single-session + suspensión; con refresh TTL 30d
   * el keyspace crece sin techo → login O(N global)).
   *
   * CONTRATO PRESERVADO: devuelve el nº de records de refresh REALMENTE borrados. `del(...keys)` cuenta solo
   * las keys que existían → un sid STALE en el índice (sesión ya vencida por TTL) NO infla el contador. No
   * asume que SMEMBERS sea perfecto: la staleness es benigna (del de una key inexistente es no-op).
   *
   * COMPAT sesiones PRE-DEPLOY: las sesiones creadas ANTES de este cambio no están en el índice → no se
   * enumeran ni se cuentan aquí. NO hay fallback al scan global (reintroducirlo pagaría el costo O(N global)
   * en CADA login justo tras el deploy, que es precisamente lo que este índice elimina). Es aceptable porque:
   * (1) la CORRECTITUD de la revocación NO depende de este borrado — el sello epoch `revoked:before:{userId}`
   * (abajo) mata TODAS las sesiones del user por `iat` en O(1), incluidas las pre-deploy; (2) sus records de
   * refresh se auto-reapan por TTL (≤30d). Net: seguridad intacta al instante, limpieza de records diferida
   * y acotada solo durante la ventana de transición.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const indexKey = this.userSessionsKey(userId);
    const sids = await this.redis.smembers(indexKey);
    let revoked = 0;
    if (sids.length > 0) {
      const keys = sids.map((sid) => this.key(sid));
      // `del` devuelve cuántas de esas keys existían REALMENTE → los sids stale (sesión ya expirada por TTL
      // pero aún en el SET) suman 0, preservando la semántica "count = sesiones efectivamente borradas".
      revoked = await this.redis.del(...keys);
    }
    // Limpia el índice entero de un golpe (las sesiones vivas ya fueron borradas arriba; los sids stale se
    // van con él). Barato y deja el keyspace prolijo sin SREM por-elemento.
    await this.redis.del(indexKey);
    // Sella `revoked:before:{userId} = now`: mata TODAS las sesiones emitidas antes de ahora de un golpe
    // (el token NUEVO, emitido después, pasa por su `iat` mayor). Cubre el race (una sesión creada durante
    // la enumeración) Y las sesiones pre-deploy ausentes del índice, sin depender de haberlas enumerado.
    await this.revocation?.revokeAllForUser(userId);
    return revoked;
  }

  /**
   * BACKSTOP DURABLE de revocación (outbox): resella `revoked:before:{userId}` a un timestamp EXPLÍCITO y
   * MONOTÓNICO (ver `SessionRevocationStore.sealRevokedBefore`). A diferencia de `revokeAllForUser` (fast-path),
   * NO toca el índice de sesiones ni borra records de refresh: el sello epoch es la ÚNICA pieza correctness-critical
   * del revoke (los records de refresh se reapan por TTL), y el backstop solo cierra la ventana en que el fast-path
   * no llegó a sellar (crash). PROPAGA el error de Redis a propósito → el consumer Kafka que lo invoca reintenta.
   *
   * @returns `true` si elevó el sello; `false` si ya había uno ≥ (o si la revocación no está cableada — el mismo
   *          fail-safe que `revokeAllForUser`, que también hace `this.revocation?`).
   */
  async resealRevokedBefore(userId: string, atEpochSeconds: number): Promise<boolean> {
    return (await this.revocation?.sealRevokedBefore(userId, atEpochSeconds)) ?? false;
  }

  async isValid(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(sessionId))) === 1;
  }
}

export type RefreshErrorCode = 'SESSION_REVOKED' | 'TOKEN_REUSE_DETECTED';

export class RefreshError extends Error {
  constructor(readonly reason: RefreshErrorCode) {
    super(reason);
    this.name = 'RefreshError';
  }
}
