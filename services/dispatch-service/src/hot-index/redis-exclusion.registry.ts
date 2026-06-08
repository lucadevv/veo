/**
 * Exclusión de conductores (prioridad de pánico, BR-T06) sobre Redis real.
 * Un SET `dispatch:excluded:drivers`; los excluidos no reciben nuevas ofertas hasta su resolución.
 */
import type Redis from 'ioredis';
import type { ExclusionRegistry } from './hot-index.port';

const EXCLUDED_SET = 'dispatch:excluded:drivers';

export class RedisExclusionRegistry implements ExclusionRegistry {
  constructor(private readonly redis: Redis) {}

  async exclude(driverId: string): Promise<void> {
    await this.redis.sadd(EXCLUDED_SET, driverId);
  }

  async isExcluded(driverId: string): Promise<boolean> {
    return (await this.redis.sismember(EXCLUDED_SET, driverId)) === 1;
  }

  async filter(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];
    const flags = await this.redis.smismember(EXCLUDED_SET, ...driverIds);
    return driverIds.filter((_, i) => flags[i] === 0);
  }

  async clear(driverId: string): Promise<void> {
    await this.redis.srem(EXCLUDED_SET, driverId);
  }
}
