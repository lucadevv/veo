/** Indicador Terminus de salud de Redis (PING). */
import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    let ok = false;
    try {
      ok = (await this.redis.ping()) === 'PONG';
    } catch {
      ok = false;
    }
    const result = this.getStatus(key, ok);
    if (ok) return result;
    throw new HealthCheckError('Redis no responde', result);
  }
}
