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
  /** jti INMEDIATAMENTE anterior (el que `currentJti` reemplazó). Habilita la ventana de gracia opcional. */
  previousJti?: string;
  /** epoch ms de la última rotación (para medir la ventana de gracia). */
  rotatedAt?: number;
  createdAt: number;
}

export interface RotationResult {
  sessionId: string;
  newJti: string;
}

/**
 * Códigos TIPADOS del resultado del CAS atómico de `rotate` (Lua) — cero strings/números mágicos sueltos:
 *  - MISSING (-1): la sesión no existe (revocada/expirada).
 *  - REUSE (0):    el jti presentado no es el vigente ni cae en la ventana de gracia → robo → matar familia.
 *  - OK (1):       rotación normal, se emitió `newJti`.
 *  - GRACE (2):    refresh concurrente/reintento LEGÍTIMO dentro de la ventana de gracia → idempotente, se
 *                  devuelve el jti VIGENTE sin rotar ni matar (solo si graceWindowMs > 0).
 */
const ROTATE_MISSING = -1;
const ROTATE_REUSE = 0;
const ROTATE_OK = 1;
const ROTATE_GRACE = 2;

/**
 * CAS ATÓMICO de rotación en un solo eval (espeja `SEAL_REVOKED_BEFORE_LUA` de session-revocation): GET del
 * record + comparación del jti + SET del nuevo jti, TODO indivisible. Cierra la carrera del RMW no atómico
 * (dos `/auth/refresh` concurrentes con el mismo jti válido leían ambos el mismo record, pasaban ambos el gate
 * y ambos escribían → el perdedor quedaba con un jti stale → reuse-detection espurio). `cjson` (incluido en el
 * Redis embebido de Lua) parsea/serializa el record dentro del eval. Backward-compatible con records viejos
 * sin previousJti/rotatedAt (cjson.decode los deja nil). Ventana de gracia: si graceMs>0 y el jti presentado
 * es el previousJti dentro de la ventana → idempotente (devuelve el vigente, NO mata) — tolera el reintento
 * legítimo. graceMs=0 (default) = detección de reuse ESTRICTA (todo jti no-vigente mata la familia).
 */
const ROTATE_CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {${ROTATE_MISSING}} end
local rec = cjson.decode(raw)
local presented = ARGV[1]
local newJti = ARGV[2]
local ttl = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local graceMs = tonumber(ARGV[5])
if rec.currentJti == presented then
  rec.previousJti = rec.currentJti
  rec.currentJti = newJti
  rec.rotatedAt = nowMs
  redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', ttl)
  return {${ROTATE_OK}, newJti}
end
if graceMs > 0 and rec.previousJti == presented and rec.rotatedAt ~= nil and (nowMs - rec.rotatedAt) <= graceMs then
  return {${ROTATE_GRACE}, rec.currentJti}
end
return {${ROTATE_REUSE}}
`;

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
    /**
     * Ventana de gracia (ms) para el jti INMEDIATAMENTE anterior: un `/auth/refresh` que presenta el
     * previousJti dentro de esta ventana se trata como reintento LEGÍTIMO (idempotente, devuelve el jti
     * vigente) en vez de reuse. Default 0 = detección de reuse ESTRICTA (comportamiento histórico: todo jti
     * no-vigente mata la familia). Se sube por DI si se quiere tolerar reintentos concurrentes (trade-off
     * conocido de la rotación de refresh: relaja la estrictez del reuse en una ventana corta). NO reduce la
     * seguridad del sello epoch de revocación (ese sigue matando por `iat`).
     */
    private readonly graceWindowMs = 0,
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
    const newJti = uuidv7();
    // CAS ATÓMICO (un solo eval): GET + comparación de jti + SET son indivisibles → dos rotate concurrentes con
    // el mismo jti NO pueden ambos ganar (el RMW no atómico anterior sí lo permitía → jti stale → reuse espurio).
    const res = (await this.redis.eval(
      ROTATE_CAS_LUA,
      1,
      this.key(sessionId),
      presentedJti,
      newJti,
      String(this.ttlSeconds),
      String(Date.now()),
      String(this.graceWindowMs),
    )) as [number, string?];
    const status = Number(res[0]);
    if (status === ROTATE_MISSING) throw new RefreshError('SESSION_REVOKED');
    if (status === ROTATE_REUSE) {
      await this.revoke(sessionId); // reuse detection → mata familia completa
      throw new RefreshError('TOKEN_REUSE_DETECTED');
    }
    // ROTATE_OK → res[1] es el newJti recién emitido; ROTATE_GRACE → res[1] es el jti VIGENTE (reintento
    // legítimo dentro de la ventana): en ambos casos el cliente recibe un jti válido y NO se mata la familia.
    return { sessionId, newJti: res[1] as string };
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

  /**
   * Enumera las sesiones VIVAS de un usuario (gestión de acceso del panel: "ver/revocar sesiones de un
   * operador"). Usa el ÍNDICE SECUNDARIO `veo:user-sessions:{userId}` (SET de sessionIds) → O(sesiones-del-user),
   * no un barrido global. Por cada sid vivo devuelve `{ id, lastActiveAt }`:
   *  - `id`: el sessionId.
   *  - `lastActiveAt`: última ACTIVIDAD de la sesión = `rotatedAt` (último refresh) ?? `createdAt` (login), en ISO
   *    8601. Es el ÚNICO dato temporal del record (no hay device/UA/geo almacenado → no se inventa).
   * Los sids STALE del índice (record ya vencido por TTL) se DESCARTAN (mismo criterio benigno que
   * `revokeAllForUser`): el SET puede contener un sid cuya key ya no existe → GET null → se omite.
   */
  async listSessionsForUser(userId: string): Promise<{ id: string; lastActiveAt: string }[]> {
    const sids = await this.redis.smembers(this.userSessionsKey(userId));
    if (sids.length === 0) return [];
    const raws = await this.redis.mget(...sids.map((sid) => this.key(sid)));
    const sessions: { id: string; lastActiveAt: string }[] = [];
    for (let i = 0; i < sids.length; i++) {
      const raw = raws[i];
      if (!raw) continue; // sid stale (sesión ya vencida por TTL) → no está viva, se omite.
      const rec = JSON.parse(raw) as SessionRecord;
      const activeMs = rec.rotatedAt ?? rec.createdAt;
      sessions.push({ id: sids[i]!, lastActiveAt: new Date(activeMs).toISOString() });
    }
    return sessions;
  }

  /**
   * Revoca UNA sesión concreta por su id (gestión de acceso del panel: el ADMIN echa una sesión puntual de un
   * operador, sin tumbar las demás). Alias semántico de {@link revoke}: borra el record de refresh + sella la
   * entrada del denylist por-sid (el access token de esa sesión, aún con firma válida ≤15m, se rechaza al
   * instante en los BFFs). Idempotente.
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.revoke(sessionId);
  }
}

export type RefreshErrorCode = 'SESSION_REVOKED' | 'TOKEN_REUSE_DETECTED';

export class RefreshError extends Error {
  constructor(readonly reason: RefreshErrorCode) {
    super(reason);
    this.name = 'RefreshError';
  }
}
