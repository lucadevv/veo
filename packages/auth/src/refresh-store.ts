/**
 * Refresh tokens con ROTACIÓN + store en Redis (decisión cliente).
 * - Cada refresh emite uno nuevo e invalida el anterior (jti rotativo).
 * - Revocable al instante: borrar la sesión mata todas sus credenciales (suspender conductor BR-D01,
 *   logout remoto, pánico).
 * - Reuse detection: si llega un jti ya rotado, es robo de token → se mata toda la familia (sesión).
 */
import type { Redis } from 'ioredis';
import { uuidv7 } from '@veo/utils';

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
    private readonly prefix = 'veo:session:',
  ) {}

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  /** Crea una sesión nueva (login). Devuelve sessionId + jti inicial. */
  async createSession(userId: string): Promise<RotationResult> {
    const sessionId = uuidv7();
    const newJti = uuidv7();
    const record: SessionRecord = { userId, currentJti: newJti, createdAt: Date.now() };
    await this.redis.set(this.key(sessionId), JSON.stringify(record), 'EX', this.ttlSeconds);
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

  /** Revoca una sesión (logout, suspensión). Idempotente. */
  async revoke(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
  }

  /** Revoca todas las sesiones de un usuario. Requiere índice secundario. */
  async revokeAllForUser(userId: string): Promise<number> {
    const stream = this.redis.scanStream({ match: `${this.prefix}*`, count: 200 });
    let revoked = 0;
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length === 0) continue;
      const values = await this.redis.mget(keys);
      const toDelete = keys.filter((_, i) => {
        const v = values[i];
        if (!v) return false;
        return (JSON.parse(v) as SessionRecord).userId === userId;
      });
      if (toDelete.length > 0) revoked += await this.redis.del(...toDelete);
    }
    return revoked;
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
