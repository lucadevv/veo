/**
 * Cliente Redis compartido (rate limiting por IP+usuario+ruta y readiness).
 */
import { type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('VEO_REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis =>
    new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: 3 }),
};

/** Cierre ordenado del cliente Redis al apagar la app. */
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
