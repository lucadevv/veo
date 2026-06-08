/**
 * Readiness del BFF (GET /health/ready de @veo/observability): Redis + alcance del servicio
 * core aguas abajo (identity). El liveness lo cubre la propia HealthController.
 */
import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { READINESS_CHECKS, type ReadinessCheck } from '@veo/observability';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import type { Env } from '../config/env.schema';

async function pingHttp(url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [REDIS, ConfigService],
  useFactory: (redis: Redis, config: ConfigService<Env, true>): ReadinessCheck[] => [
    {
      name: 'redis',
      check: async () => (await redis.ping()) === 'PONG',
    },
    {
      name: 'identity',
      check: async () => {
        // identity-service no excluye el health del prefijo global, así que su sonda
        // vive en /api/v1/health (IDENTITY_URL es la base cruda; el RestGateway añade /api/v1).
        const base = config.getOrThrow<string>('IDENTITY_URL').replace(/\/$/, '');
        return pingHttp(`${base}/api/v1/health`, 2000);
      },
    },
  ],
};
