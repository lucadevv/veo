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

/**
 * Store en memoria que ejecuta el script Lua atómico de ventana fija (INCR + PEXPIRE-en-el-primer-hit
 * + PTTL) igual que Redis. Expone counts/ttls para inspección. El invariante FIX 3 (la clave SIEMPRE
 * tiene TTL) se cumple porque el `eval` es atómico: el PEXPIRE va en la misma llamada que el INCR.
 */
class FakeStore implements RateLimitStore {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  eval(_script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    if (next === 1) this.ttls.set(key, windowMs);
    return Promise.resolve([next, this.ttls.get(key) ?? -1]);
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
    const evalSpy = vi.spyOn(store, 'eval');
    const guard = new RateLimitGuard(reflector, store, config as never);
    const ctx = httpContext(
      { ip: '1.1.1.1', url: '/panic', method: 'POST' },
      withMeta(SKIP_RATE_LIMIT_KEY, true),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(evalSpy).not.toHaveBeenCalled();
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

  describe('FIX A · @RateLimit con ARREGLO (cap fino IP+phone Y cap AGREGADO por-IP) anti SMS-bombing', () => {
    const dual = (perIpMax: number): RateLimitOptions[] => [
      { max: 5, windowMs: 600_000, by: ['ip', 'phone'] },
      { max: perIpMax, windowMs: 600_000, by: ['ip'] },
    ];

    it('una IP fija NO puede disparar SMS a N teléfonos sin techo: la 21ª request → 429', async () => {
      const reflector = new Reflector();
      const store = new FakeStore();
      const guard = new RateLimitGuard(reflector, store, config as never);
      const handler = withMeta(RATE_LIMIT_KEY, dual(20));
      const mk = (phone: string): ExecutionContext =>
        httpContext(
          { ip: '7.7.7.7', url: '/auth/otp/request', method: 'POST', body: { phone } },
          handler,
        );
      // 20 teléfonos DISTINTOS: cada uno pasa el cap fino (1<5) pero suma al cap por-IP.
      for (let i = 1; i <= 20; i++) {
        await expect(guard.canActivate(mk(`90000${String(i).padStart(4, '0')}`))).resolves.toBe(
          true,
        );
      }
      // La 21ª, a un teléfono NUEVO, choca con el cap AGREGADO por-IP → 429.
      await expect(guard.canActivate(mk('900099999'))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('el cap fino por IP+teléfono corta el retry del MISMO número (6ª al mismo phone → 429)', async () => {
      const reflector = new Reflector();
      const store = new FakeStore();
      const guard = new RateLimitGuard(reflector, store, config as never);
      const handler = withMeta(RATE_LIMIT_KEY, dual(100)); // cap por-IP holgado: aísla el cap fino.
      const mk = (): ExecutionContext =>
        httpContext(
          { ip: '8.8.8.8', url: '/auth/otp/request', method: 'POST', body: { phone: '900000001' } },
          handler,
        );
      for (let i = 0; i < 5; i++) await expect(guard.canActivate(mk())).resolves.toBe(true);
      await expect(guard.canActivate(mk())).rejects.toBeInstanceOf(RateLimitError);
    });
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

  describe('FIX 1 · canonicalización del teléfono (anti bypass Nx del cap fino IP+phone)', () => {
    // El DTO acepta el MISMO número en 3 formas; sin canonicalizar abrían 3 cubos → 3x el cap de 5.
    const mkGuard = () => new RateLimitGuard(new Reflector(), new FakeStore(), config as never);

    it('las 3 representaciones del MISMO número comparten el cubo (cap 5 → la 6ª en cualquier forma → 429)', async () => {
      const guard = mkGuard();
      const handler = withMeta(RATE_LIMIT_KEY, {
        max: 5,
        windowMs: 600_000,
        by: ['ip', 'phone'],
      } satisfies RateLimitOptions);
      const mk = (phone: string): ExecutionContext =>
        httpContext({ ip: '9.9.9.9', url: '/auth/otp/request', method: 'POST', body: { phone } }, handler);
      const [bare, cc, e164] = ['987654321', '51987654321', '+51987654321'];
      // 5 hits repartidos entre las 3 formas: si NO colapsaran a una key, ninguna llegaría a 5.
      await expect(guard.canActivate(mk(bare))).resolves.toBe(true);
      await expect(guard.canActivate(mk(cc))).resolves.toBe(true);
      await expect(guard.canActivate(mk(e164))).resolves.toBe(true);
      await expect(guard.canActivate(mk(bare))).resolves.toBe(true);
      await expect(guard.canActivate(mk(cc))).resolves.toBe(true);
      // 6ª (3ra forma) → mismo cubo agotado → 429.
      await expect(guard.canActivate(mk(e164))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('números DISTINTOS siguen en cubos separados (no colapsa de más)', async () => {
      const guard = mkGuard();
      const handler = withMeta(RATE_LIMIT_KEY, {
        max: 1,
        windowMs: 600_000,
        by: ['ip', 'phone'],
      } satisfies RateLimitOptions);
      const mk = (phone: string): ExecutionContext =>
        httpContext({ ip: '10.10.10.10', url: '/auth/otp/request', method: 'POST', body: { phone } }, handler);
      await expect(guard.canActivate(mk('987654321'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('987654322'))).resolves.toBe(true);
    });
  });
});
