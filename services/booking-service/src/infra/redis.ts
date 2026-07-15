/**
 * Cliente Redis compartido. F0 no lo usa en el hot-path (el lock de asientos del §6 es F3, sobre la fila
 * DB, no Redis); se provee igual para los gates/locks de fases futuras y SÍ se chequea en el readiness
 * (sonda PING en /health/ready, app.module) — el comentario no miente: lo que se provee, se sondea.
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
    return createRedisClient(config.getOrThrow<string>('REDIS_URL'), {
      logger: new Logger('Redis'),
    });
  },
};
