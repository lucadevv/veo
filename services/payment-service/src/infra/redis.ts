/**
 * Cliente Redis compartido (locks de cron para payouts/conciliación, idempotencia auxiliar).
 */
import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis => {
    return new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: 3 });
  },
};
