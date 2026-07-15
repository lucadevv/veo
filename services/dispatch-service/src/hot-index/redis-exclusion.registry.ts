/**
 * Exclusión por PÁNICO del pool de matching sobre Redis real (un SET de driverIds; los excluidos NO
 * reciben nuevas ofertas hasta que se los limpia). Ciclo de vida: se limpia por RESOLUCIÓN del incidente
 * (BR-T06) — SIN TTL, porque un pánico abierto debe mantener al conductor fuera hasta que el operador lo
 * resuelva. La exclusión por SUSPENSIÓN vive en otra implementación (RedisTtlExclusionRegistry, con TTL de
 * auto-cura) — ciclo de vida distinto: ahí el modo de falla seguro es re-admitir, no quedar pegado.
 */
import type Redis from 'ioredis';
import type { ExclusionRegistry } from './hot-index.port';

/** SET de Redis de los conductores excluidos por pánico. */
const PANIC_EXCLUDED_SET = 'dispatch:excluded:drivers';

export class RedisExclusionRegistry implements ExclusionRegistry {
  constructor(private readonly redis: Redis) {}

  async exclude(driverId: string): Promise<void> {
    await this.redis.sadd(PANIC_EXCLUDED_SET, driverId);
  }

  async isExcluded(driverId: string): Promise<boolean> {
    return (await this.redis.sismember(PANIC_EXCLUDED_SET, driverId)) === 1;
  }

  async filter(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];
    const flags = await this.redis.smismember(PANIC_EXCLUDED_SET, ...driverIds);
    return driverIds.filter((_, i) => flags[i] === 0);
  }

  async clear(driverId: string): Promise<void> {
    await this.redis.srem(PANIC_EXCLUDED_SET, driverId);
  }
}
