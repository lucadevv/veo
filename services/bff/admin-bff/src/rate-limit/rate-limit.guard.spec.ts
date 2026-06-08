import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { RateLimitError } from '@veo/utils';
import { RateLimitGuard } from './rate-limit.guard';
import type { Env } from '../config/env.schema';

function fakeConfig(max: number): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'RATE_LIMIT_MAX' ? max : 60_000),
  } as unknown as ConfigService<Env, true>;
}

function fakeRedis(count: number): Redis {
  const chain = {
    zremrangebyscore: () => chain,
    zadd: () => chain,
    zcard: () => chain,
    pexpire: () => chain,
    exec: () =>
      Promise.resolve([
        [null, 0],
        [null, 1],
        [null, count],
        [null, 1],
      ]),
  };
  return { multi: () => chain } as unknown as Redis;
}

function fakeReflector(skip: boolean): Reflector {
  return { getAllAndOverride: () => skip } as unknown as Reflector;
}

function ctx(path: string): ExecutionContext {
  const req = { headers: {}, ip: '1.2.3.4', path };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('permite cuando el conteo no supera el máximo', async () => {
    const guard = new RateLimitGuard(fakeReflector(false), fakeRedis(2), fakeConfig(2));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).resolves.toBe(true);
  });

  it('lanza RateLimitError (429) cuando se supera el máximo', async () => {
    const guard = new RateLimitGuard(fakeReflector(false), fakeRedis(3), fakeConfig(2));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).rejects.toBeInstanceOf(RateLimitError);
  });

  it('exime health/metrics del límite', async () => {
    const guard = new RateLimitGuard(fakeReflector(false), fakeRedis(999), fakeConfig(1));
    await expect(guard.canActivate(ctx('/health'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('/metrics'))).resolves.toBe(true);
  });

  it('respeta @SkipRateLimit()', async () => {
    const guard = new RateLimitGuard(fakeReflector(true), fakeRedis(999), fakeConfig(1));
    await expect(guard.canActivate(ctx('/api/v1/auth/logout'))).resolves.toBe(true);
  });
});
