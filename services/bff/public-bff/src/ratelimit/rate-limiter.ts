/**
 * Rate limiter de ventana fija backed en Redis. ATÓMICO por clave (INCR + PEXPIRE-en-el-primer-hit
 * en UN SOLO script Lua, vía `consumeFixedWindow` de @veo/utils — implementación COMPARTIDA por los
 * 3 BFFs, sin divergir). Sin estado en proceso (escala horizontalmente). La clave combina IP +
 * usuario + ruta. La atomicidad garantiza que una clave recién creada SIEMPRE tenga TTL (nunca un
 * bucket permanente que bloquee al cliente legítimo por una caída entre INCR y EXPIRE).
 */
import { consumeFixedWindow, type RateLimitRedis } from '@veo/utils';

/** Subconjunto de Redis necesario: `eval` (EVAL). Compatible con ioredis. */
export type RateLimitStore = RateLimitRedis;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Solicitudes restantes en la ventana actual (nunca negativo). */
  remaining: number;
}

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /**
   * Registra un hit para `id` y decide si se permite según el límite de la ventana.
   * `overrides` permite endurecer una ruta puntual (decorator `@RateLimit`) sin tocar la config
   * global: si vienen, usan esos `max`/`windowMs`; si no, caen al default del limiter.
   */
  async consume(
    id: string,
    overrides?: { max?: number; windowMs?: number },
  ): Promise<RateLimitResult> {
    const max = overrides?.max ?? this.max;
    const windowMs = overrides?.windowMs ?? this.windowMs;
    const result = await consumeFixedWindow(this.store, `rl:${id}`, max, windowMs);
    return {
      allowed: result.allowed,
      count: result.count,
      limit: result.limit,
      remaining: result.remaining,
    };
  }
}
