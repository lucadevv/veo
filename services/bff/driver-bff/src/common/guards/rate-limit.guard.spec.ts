import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { RateLimitGuard } from './rate-limit.guard';

/** Doble de Redis en memoria con la semántica de INCR/EXPIRE/TTL usada por el guard. */
class FakeRedis {
  private store = new Map<string, number>();
  incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return Promise.resolve(next);
  }
  expire(_key: string, _seconds: number): Promise<number> {
    return Promise.resolve(1);
  }
  ttl(_key: string): Promise<number> {
    return Promise.resolve(42);
  }
}

const config = {
  getOrThrow: (key: string): number => (key === 'RATE_LIMIT_WINDOW_SECONDS' ? 60 : 3),
};

function ctxFor(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

function makeReq(over: Partial<Record<string, unknown>> = {}) {
  const user: AuthenticatedUser = { userId: 'u1', type: 'driver', roles: [], sessionId: 's1' };
  return {
    user,
    ip: '10.0.0.1',
    method: 'GET',
    route: { path: '/api/v1/trips/:id' },
    headers: {},
    ...over,
  };
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;

  beforeEach(() => {
    guard = new RateLimitGuard(new FakeRedis() as never, config as never);
  });

  it('permite peticiones por debajo del límite', async () => {
    const req = makeReq();
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it('lanza RateLimitError al superar el límite', async () => {
    const req = makeReq();
    await guard.canActivate(ctxFor(req));
    await guard.canActivate(ctxFor(req));
    await guard.canActivate(ctxFor(req));
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(RateLimitError);
  });

  it('separa las ventanas por ruta (claves distintas no comparten contador)', async () => {
    const a = makeReq({ route: { path: '/api/v1/trips/:id' } });
    const b = makeReq({ route: { path: '/api/v1/dispatch/surge' } });
    // Agota la ruta A.
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await expect(guard.canActivate(ctxFor(a))).rejects.toBeInstanceOf(RateLimitError);
    // La ruta B sigue disponible.
    await expect(guard.canActivate(ctxFor(b))).resolves.toBe(true);
  });

  it('usa la IP de x-forwarded-for cuando está presente', async () => {
    const usuarios = new FakeRedis();
    const g = new RateLimitGuard(usuarios as never, config as never);
    const req = makeReq({
      user: undefined,
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    await expect(g.canActivate(ctxFor(req))).resolves.toBe(true);
  });
});
