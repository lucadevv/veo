/** Tests del rate limiter de ventana fija, override por ruta (@RateLimit) y @SkipRateLimit (POST /panic). */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitError } from '@veo/utils';
import { RateLimiter, type RateLimitStore } from './rate-limiter';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';

/** Store en memoria que imita INCR/PEXPIRE de Redis. Expone las claves para inspección. */
class FakeStore implements RateLimitStore {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }
  pexpire(key: string, ms: number): Promise<number> {
    this.ttls.set(key, ms);
    return Promise.resolve(1);
  }
}

describe('RateLimiter', () => {
  it('permite hasta el máximo y luego bloquea', async () => {
    const limiter = new RateLimiter(new FakeStore(), 60_000, 3);
    const r1 = await limiter.consume('a');
    const r2 = await limiter.consume('a');
    const r3 = await limiter.consume('a');
    const r4 = await limiter.consume('a');
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false);
  });

  it('cuentas independientes por clave', async () => {
    const limiter = new RateLimiter(new FakeStore(), 60_000, 1);
    expect((await limiter.consume('x')).allowed).toBe(true);
    expect((await limiter.consume('y')).allowed).toBe(true);
    expect((await limiter.consume('x')).allowed).toBe(false);
  });

  it('override de max/windowMs reemplaza el default del limiter', async () => {
    const store = new FakeStore();
    // Default global laxo (100/min) pero el override endurece a 2 en una ventana custom.
    const limiter = new RateLimiter(store, 60_000, 100);
    const opts = { max: 2, windowMs: 600_000 };
    expect((await limiter.consume('k', opts)).allowed).toBe(true);
    expect((await limiter.consume('k', opts)).allowed).toBe(true);
    const blocked = await limiter.consume('k', opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(2);
    // El TTL fijado en el primer hit usa la ventana del override, no la global.
    expect(store.ttls.get('rl:k')).toBe(600_000);
  });
});

/** Construye un ExecutionContext HTTP. La metadata se setea sobre `handler` con Reflect (Reflector real). */
function httpContext(req: unknown, handler: () => void): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** Aplica metadata (como hacen los decorators) sobre una función handler para que el Reflector la lea. */
function withMeta(key: string, value: unknown): () => void {
  const handler = (): void => {};
  Reflect.defineMetadata(key, value, handler);
  return handler;
}

describe('RateLimitGuard', () => {
  const config = { getOrThrow: (k: string) => (k === 'RATE_LIMIT_WINDOW_MS' ? 60_000 : 1) };

  it('omite el límite en handlers marcados con @SkipRateLimit (POST /panic)', async () => {
    const reflector = new Reflector();
    const store = new FakeStore();
    const incr = vi.spyOn(store, 'incr');
    const guard = new RateLimitGuard(reflector, store, config as never);
    const ctx = httpContext(
      { ip: '1.1.1.1', url: '/panic', method: 'POST' },
      withMeta(SKIP_RATE_LIMIT_KEY, true),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(incr).not.toHaveBeenCalled();
  });

  it('bloquea con RateLimitError al exceder el máximo global', async () => {
    const reflector = new Reflector();
    const guard = new RateLimitGuard(reflector, new FakeStore(), config as never);
    const ctx = httpContext({ ip: '2.2.2.2', url: '/trips', method: 'POST' }, () => {});
    await expect(guard.canActivate(ctx)).resolves.toBe(true); // global max = 1
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('no limita contextos no-HTTP (WebSocket)', async () => {
    const reflector = new Reflector();
    const guard = new RateLimitGuard(reflector, new FakeStore(), config as never);
    const wsCtx = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(guard.canActivate(wsCtx)).resolves.toBe(true);
  });

  it('@RateLimit aplica el límite custom (5/ventana) en vez del global', async () => {
    const reflector = new Reflector();
    const store = new FakeStore();
    // Global laxo (config.max = 1) NO debe entrar: el override permite 5 antes de bloquear.
    const laxConfig = { getOrThrow: (k: string) => (k === 'RATE_LIMIT_WINDOW_MS' ? 60_000 : 1) };
    const guard = new RateLimitGuard(reflector, store, laxConfig as never);
    const override: RateLimitOptions = { max: 5, windowMs: 600_000, by: ['ip', 'phone'] };
    const req = {
      ip: '3.3.3.3',
      url: '/auth/otp/request',
      method: 'POST',
      body: { phone: '987654321' },
    };
    const ctx = httpContext(req, withMeta(RATE_LIMIT_KEY, override));
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitError); // el 6to
  });

  it('@RateLimit con by:[ip,phone] separa contadores por teléfono', async () => {
    const reflector = new Reflector();
    const store = new FakeStore();
    const guard = new RateLimitGuard(reflector, store, config as never);
    const override: RateLimitOptions = { max: 1, windowMs: 600_000, by: ['ip', 'phone'] };
    const handler = withMeta(RATE_LIMIT_KEY, override);
    const mk = (phone: string): ExecutionContext =>
      httpContext(
        { ip: '4.4.4.4', url: '/auth/otp/request', method: 'POST', body: { phone } },
        handler,
      );
    // Misma IP, teléfonos distintos → contadores independientes.
    await expect(guard.canActivate(mk('900000001')).catch((e) => e)).resolves.toBe(true);
    await expect(guard.canActivate(mk('900000002')).catch((e) => e)).resolves.toBe(true);
    // Repetir el primer teléfono supera su límite de 1.
    await expect(guard.canActivate(mk('900000001'))).rejects.toBeInstanceOf(RateLimitError);
  });

  it('@RateLimit normaliza el email del body (trim + minúsculas) para la clave', async () => {
    const reflector = new Reflector();
    const store = new FakeStore();
    const guard = new RateLimitGuard(reflector, store, config as never);
    const override: RateLimitOptions = { max: 1, windowMs: 600_000, by: ['ip', 'email'] };
    const handler = withMeta(RATE_LIMIT_KEY, override);
    const ctxA = httpContext(
      {
        ip: '5.5.5.5',
        url: '/auth/email/login',
        method: 'POST',
        body: { email: ' User@Example.com ' },
      },
      handler,
    );
    const ctxB = httpContext(
      {
        ip: '5.5.5.5',
        url: '/auth/email/login',
        method: 'POST',
        body: { email: 'user@example.com' },
      },
      handler,
    );
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    // Mismo email normalizado → comparte contador → el segundo bloquea.
    await expect(guard.canActivate(ctxB)).rejects.toBeInstanceOf(RateLimitError);
  });
});
