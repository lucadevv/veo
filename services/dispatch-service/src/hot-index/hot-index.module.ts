/**
 * Wirea el hot index y el registro de exclusión a sus implementaciones Redis (producción).
 * Global: lo consumen el dominio de matching y los consumidores Kafka.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { HOT_INDEX, EXCLUSION_REGISTRY, SUSPENSION_REGISTRY } from './hot-index.port';
import { RedisHotIndex } from './redis-hot-index';
import { RedisExclusionRegistry } from './redis-exclusion.registry';
import { RedisTtlExclusionRegistry } from './redis-ttl-exclusion.registry';
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

// Exclusión por SUSPENSIÓN del conductor: implementación con TTL de AUTO-CURA (per-key, NO el SET de pánico).
// El TTL acota la over-exclusion al lado SEGURO (re-admitir si la señal de cierre no llega); ver el comment
// canónico en RedisTtlExclusionRegistry. Ciclo de vida distinto al de pánico → implementación distinta.
const suspensionProvider: Provider = {
  provide: SUSPENSION_REGISTRY,
  inject: [REDIS, ConfigService],
  useFactory: (redis: Redis, config: ConfigService<Env, true>) =>
    new RedisTtlExclusionRegistry(redis, config.getOrThrow<number>('SUSPENSION_EXCLUSION_TTL_SECONDS')),
};

@Global()
@Module({
  providers: [hotIndexProvider, exclusionProvider, suspensionProvider],
  exports: [HOT_INDEX, EXCLUSION_REGISTRY, SUSPENSION_REGISTRY],
})
export class HotIndexModule {}
