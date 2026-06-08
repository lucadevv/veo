/**
 * HealthModule: monta el HealthController base de @veo/observability (GET /health, /health/ready)
 * y provee los ReadinessCheck del BFF: Redis (rate-limit + read-model) y ClickHouse (analítica).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from '@veo/observability';
import { REDIS } from '../infra/tokens';
import type { Env } from '../config/env.schema';

const checksProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [REDIS, ConfigService],
  useFactory: (redis: Redis, config: ConfigService<Env, true>): ReadinessCheck[] => [
    {
      name: 'redis',
      check: async (): Promise<boolean> => (await redis.ping()) === 'PONG',
    },
    {
      name: 'clickhouse',
      check: async (): Promise<boolean> => {
        const url = config.get('CLICKHOUSE_URL', { infer: true });
        const res = await fetch(`${url.replace(/\/$/, '')}/ping`);
        return res.ok;
      },
    },
  ],
};

@Module({
  controllers: [HealthController],
  providers: [checksProvider],
})
export class HealthModule {}
