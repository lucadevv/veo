/**
 * Cliente Redis compartido (locks de cron para payouts/conciliación, idempotencia auxiliar).
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, type Redis } from '@veo/redis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis => {
    // Resiliencia (servicio de DINERO con outbox relay): la config resiliente
    // (maxRetriesPerRequest null + retryStrategy con techo + handler on('error'))
    // vive ahora en el factory compartido @veo/redis. Ante un rebote transitorio
    // de Redis NO morimos: reintenta sin lanzar MaxRetriesPerRequestError.
    return createRedisClient(config.getOrThrow<string>('REDIS_URL'), {
      logger: new Logger('Redis'),
    });
  },
};
