/**
 * Rate limiter de ventana fija backed en Redis. Atómico por clave: INCR + PEXPIRE en el primer hit.
 * Sin estado en proceso (escala horizontalmente). La clave combina IP + usuario + ruta.
 */

/** Subconjunto de Redis necesario (compatible con ioredis). */
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
}

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
    const key = `rl:${id}`;
    const count = await this.store.incr(key);
    // Solo el primer hit fija el TTL de la ventana (evita reiniciarla en cada solicitud).
    if (count === 1) await this.store.pexpire(key, windowMs);
    const remaining = Math.max(0, max - count);
    return { allowed: count <= max, count, limit: max, remaining };
  }
}
