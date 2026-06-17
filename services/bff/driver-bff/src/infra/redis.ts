/**
 * Cliente Redis compartido. Lo usa el rate limiter (ventana fija por IP+usuario+ruta).
 */
import {
  type Provider,
  type OnApplicationShutdown,
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, type Redis } from '@veo/redis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis =>
    createRedisClient(config.getOrThrow<string>('REDIS_URL'), {
      logger: new Logger('Redis'),
      lazyConnect: false,
    }),
};

/** Cierre ordenado del cliente Redis al apagar la app. */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
