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

function ctx(
  path: string,
  opts: { headers?: Record<string, string | string[]>; ip?: string } = {},
): ExecutionContext {
  const req = { headers: opts.headers ?? {}, ip: opts.ip ?? '1.2.3.4', path };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/**
 * Captura la key que el guard arma con la IP del cliente. zadd recibe `bff:admin:rl:<ip>:<subject>`,
 * así que inspeccionamos su primer argumento para afirmar qué IP resolvió clientIp().
 */
function capturingRedis(count: number): { redis: Redis; keys: string[] } {
  const keys: string[] = [];
  const chain = {
    zremrangebyscore: () => chain,
    zadd: (key: string) => {
      keys.push(key);
      return chain;
    },
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
  return { redis: { multi: () => chain } as unknown as Redis, keys };
}

describe('RateLimitGuard', () => {
  it('permite cuando el conteo no supera el máximo', async () => {
    const guard = new RateLimitGuard(fakeReflector(false), fakeRedis(2), fakeConfig(2));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).resolves.toBe(true);
  });

  it('lanza RateLimitError (429) cuando se supera el máximo', async () => {
    const guard = new RateLimitGuard(fakeReflector(false), fakeRedis(3), fakeConfig(2));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).rejects.toBeInstanceOf(
      RateLimitError,
    );
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

  describe('clientIp · precedencia cf-connecting-ip (detrás de cloudflared)', () => {
    it('usa cf-connecting-ip POR ENCIMA de x-forwarded-for (el túnel pone 127.0.0.1 en xff)', async () => {
      const { redis, keys } = capturingRedis(1);
      const guard = new RateLimitGuard(fakeReflector(false), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', {
          headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '127.0.0.1' },
        }),
      );
      expect(keys[0]).toContain(':203.0.113.7:');
      expect(keys[0]).not.toContain('127.0.0.1');
    });

    it('soporta cf-connecting-ip como string[] (toma el primero)', async () => {
      const { redis, keys } = capturingRedis(1);
      const guard = new RateLimitGuard(fakeReflector(false), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', { headers: { 'cf-connecting-ip': ['203.0.113.9', '10.0.0.1'] } }),
      );
      expect(keys[0]).toContain(':203.0.113.9:');
    });

    it('cae a x-forwarded-for cuando no hay cf-connecting-ip', async () => {
      const { redis, keys } = capturingRedis(1);
      const guard = new RateLimitGuard(fakeReflector(false), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', { headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } }),
      );
      expect(keys[0]).toContain(':198.51.100.4:');
    });
  });
});
