/**
 * Cliente Redis compartido (readiness probe; rate-limit de endpoints NO críticos).
 * El endpoint POST /panic JAMÁS se throttlea (decisión de seguridad, ver README BR-S04).
 */
import { Logger, type Provider, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, type Redis } from '@veo/redis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis => {
    return createRedisClient(config.getOrThrow<string>('REDIS_URL'), { logger: new Logger('Redis') });
  },
};

/** Cierre ordenado del cliente Redis al apagar la app. */
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
