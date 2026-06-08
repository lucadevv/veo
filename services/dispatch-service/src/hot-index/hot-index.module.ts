/**
 * Wirea el hot index y el registro de exclusión a sus implementaciones Redis (producción).
 * Global: lo consumen el dominio de matching y los consumidores Kafka.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { HOT_INDEX, EXCLUSION_REGISTRY } from './hot-index.port';
import { RedisHotIndex } from './redis-hot-index';
import { RedisExclusionRegistry } from './redis-exclusion.registry';
import type { Env } from '../config/env.schema';

const hotIndexProvider: Provider = {
  provide: HOT_INDEX,
  inject: [REDIS, ConfigService],
  useFactory: (redis: Redis, config: ConfigService<Env, true>) =>
    new RedisHotIndex(redis, config.getOrThrow<number>('DRIVER_LOC_TTL_SECONDS')),
};

const exclusionProvider: Provider = {
  provide: EXCLUSION_REGISTRY,
  inject: [REDIS],
  useFactory: (redis: Redis) => new RedisExclusionRegistry(redis),
};

@Global()
@Module({
  providers: [hotIndexProvider, exclusionProvider],
  exports: [HOT_INDEX, EXCLUSION_REGISTRY],
})
export class HotIndexModule {}
