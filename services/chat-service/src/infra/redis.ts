/**
 * Cliente Redis compartido (solo readiness en chat-service).
 */
import { type Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, type Redis } from '@veo/redis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis =>
    createRedisClient(config.getOrThrow<string>('REDIS_URL'), { logger: new Logger('Redis') }),
};
