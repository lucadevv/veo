import type { MapsCache } from './types.js';

/** Cliente Redis mínimo (compatible con ioredis) que necesita el cache de mapas. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/** Caché de mapas sobre Redis. Las rutas/geocodes son estables → vale la pena cachear. */
export class RedisMapsCache implements MapsCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'maps:',
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.prefix + key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, value, 'EX', ttlSeconds);
  }
}

/** Caché en memoria con expiración (para dev/tests sin Redis). */
export class InMemoryMapsCache implements MapsCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
