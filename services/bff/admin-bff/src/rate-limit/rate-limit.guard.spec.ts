import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { RateLimitError } from '@veo/utils';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';
import type { Env } from '../config/env.schema';

/** getOrThrow stub: ventana fija de 60s; max configurable. */
function fakeConfig(max: number): ConfigService<Env, true> {
  return {
    getOrThrow: (key: string) => (key === 'RATE_LIMIT_MAX' ? max : 60_000),
  } as unknown as ConfigService<Env, true>;
}

/**
 * Redis fake que ejecuta el script Lua atómico de ventana fija (INCR + PEXPIRE-en-el-primer-hit +
 * PTTL). Captura las claves consultadas (la clave es KEYS[1] = 3er arg posicional de eval) y los TTLs
 * para afirmar el invariante FIX 3.
 */
function fakeRedis(): { redis: Redis; keys: string[]; ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  const keys: string[] = [];
  const redis = {
    eval: (_script: string, _numKeys: number, ...args: Array<string | number>) => {
      const key = String(args[0]);
      const windowMs = Number(args[1]);
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next === 1) ttls.set(key, windowMs);
      return Promise.resolve([next, ttls.get(key) ?? -1]);
    },
  } as unknown as Redis;
  return { redis, keys, ttls };
}

function reflectorWithMeta(meta: Record<string, unknown> = {}): Reflector {
  const r = new Reflector();
  // Reflector.getAllAndOverride lee de los targets; acá lo cortocircuitamos por clave.
  (r as unknown as { getAllAndOverride: (key: string) => unknown }).getAllAndOverride = (
    key: string,
  ) => meta[key];
  return r;
}

function ctx(
  path: string,
  opts: {
    headers?: Record<string, string | string[]>;
    ip?: string;
    method?: string;
    route?: { path?: string };
    body?: Record<string, unknown>;
  } = {},
): ExecutionContext {
  const req = {
    headers: opts.headers ?? {},
    ip: opts.ip ?? '1.2.3.4',
    path,
    method: opts.method ?? 'GET',
    route: opts.route,
    body: opts.body,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('permite cuando el conteo no supera el máximo', async () => {
    const { redis } = fakeRedis();
    const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(2));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).resolves.toBe(true);
  });

  it('lanza RateLimitError (429) cuando se supera el máximo', async () => {
    const { redis } = fakeRedis();
    const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(2));
    await guard.canActivate(ctx('/api/v1/ops/trips'));
    await guard.canActivate(ctx('/api/v1/ops/trips'));
    await expect(guard.canActivate(ctx('/api/v1/ops/trips'))).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('exime health/metrics del límite', async () => {
    const { redis } = fakeRedis();
    const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(1));
    await expect(guard.canActivate(ctx('/health'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('/metrics'))).resolves.toBe(true);
  });

  it('respeta @SkipRateLimit()', async () => {
    const { redis } = fakeRedis();
    const guard = new RateLimitGuard(
      reflectorWithMeta({ [SKIP_RATE_LIMIT_KEY]: true }),
      redis,
      fakeConfig(1),
    );
    await expect(guard.canActivate(ctx('/api/v1/auth/logout'))).resolves.toBe(true);
  });

  it('ATOMICIDAD: la clave SIEMPRE queda con TTL (no bucket permanente)', async () => {
    const { redis, ttls } = fakeRedis();
    const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(5));
    await guard.canActivate(ctx('/api/v1/ops/trips'));
    expect(ttls.size).toBe(1);
    for (const ttl of ttls.values()) expect(ttl).toBeGreaterThan(0);
  });

  describe('FIX [5] · la clave global incluye método:ruta (no se comparte cubo entre endpoints)', () => {
    it('endpoints distintos → claves distintas (un endpoint ruidoso no agota a los demás)', async () => {
      const { redis, keys } = fakeRedis();
      const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', { method: 'GET', route: { path: '/ops/trips' } }),
      );
      await guard.canActivate(
        ctx('/api/v1/ops/drivers', { method: 'POST', route: { path: '/ops/drivers' } }),
      );
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).toContain(':GET:');
      expect(keys[1]).toContain(':POST:');
    });
  });

  describe('clientIp · usa req.ip (Express trust proxy) — headers crudos NO ganan', () => {
    it('SEGURIDAD: un cf-connecting-ip/x-forwarded-for inyectado NO gana sobre req.ip', async () => {
      const { redis, keys } = fakeRedis();
      const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', {
          headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' },
          ip: '203.0.113.7',
        }),
      );
      expect(keys[0]).toContain(':203.0.113.7:'); // la IP REAL (req.ip)
      expect(keys[0]).not.toContain('1.2.3.4'); // la IP inyectada NO entra en la clave
    });

    it('SEGURIDAD: rotar el header NO da cubo fresco — misma req.ip → MISMA clave', async () => {
      const { redis, keys } = fakeRedis();
      const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(10));
      await guard.canActivate(
        ctx('/api/v1/ops/trips', { headers: { 'x-forwarded-for': '9.9.9.1' }, ip: '203.0.113.7' }),
      );
      await guard.canActivate(
        ctx('/api/v1/ops/trips', { headers: { 'x-forwarded-for': '9.9.9.2' }, ip: '203.0.113.7' }),
      );
      expect(keys[0]).toBe(keys[1]);
    });

    it('tráfico legítimo: dos clientes reales distintos (req.ip) → claves distintas', async () => {
      const { redis, keys } = fakeRedis();
      const guard = new RateLimitGuard(reflectorWithMeta(), redis, fakeConfig(10));
      await guard.canActivate(ctx('/api/v1/ops/trips', { ip: '203.0.113.7' }));
      await guard.canActivate(ctx('/api/v1/ops/trips', { ip: '198.51.100.4' }));
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  describe('FIX 6 · override @RateLimit POR MÉTODO (ADR-012)', () => {
    const override: RateLimitOptions = { max: 2, windowMs: 600_000, by: ['ip', 'email'] };

    it('aplica el límite estricto del decorator (2) en vez del global', async () => {
      const { redis } = fakeRedis();
      // Global laxo (100) pero el override endurece a 2.
      const guard = new RateLimitGuard(
        reflectorWithMeta({ [RATE_LIMIT_KEY]: override }),
        redis,
        fakeConfig(100),
      );
      const mk = () => ctx('/api/v1/auth/login', { ip: '5.5.5.5', body: { email: 'a@b.com' } });
      await expect(guard.canActivate(mk())).resolves.toBe(true);
      await expect(guard.canActivate(mk())).resolves.toBe(true);
      await expect(guard.canActivate(mk())).rejects.toBeInstanceOf(RateLimitError);
    });

    it('by:[ip,email] separa contadores por email (misma IP)', async () => {
      const { redis } = fakeRedis();
      const strict: RateLimitOptions = { max: 1, windowMs: 600_000, by: ['ip', 'email'] };
      const guard = new RateLimitGuard(
        reflectorWithMeta({ [RATE_LIMIT_KEY]: strict }),
        redis,
        fakeConfig(100),
      );
      const mk = (email: string) => ctx('/api/v1/auth/login', { ip: '4.4.4.4', body: { email } });
      await expect(guard.canActivate(mk('user1@b.com'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('user2@b.com'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('user1@b.com'))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('normaliza el email (trim + minúsculas) en la clave del override', async () => {
      const { redis } = fakeRedis();
      const strict: RateLimitOptions = { max: 1, windowMs: 600_000, by: ['ip', 'email'] };
      const guard = new RateLimitGuard(
        reflectorWithMeta({ [RATE_LIMIT_KEY]: strict }),
        redis,
        fakeConfig(100),
      );
      await expect(
        guard.canActivate(
          ctx('/api/v1/auth/login', { ip: '5.5.5.5', body: { email: ' A@B.com ' } }),
        ),
      ).resolves.toBe(true);
      // Mismo email normalizado → mismo cubo → el segundo bloquea.
      await expect(
        guard.canActivate(ctx('/api/v1/auth/login', { ip: '5.5.5.5', body: { email: 'a@b.com' } })),
      ).rejects.toBeInstanceOf(RateLimitError);
    });
  });
});
