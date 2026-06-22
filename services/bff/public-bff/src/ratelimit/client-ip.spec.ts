/**
 * FIX 1 — la IP del cliente debe resolverse de los HEADERS reales del borde, no de `req.ips` (que
 * solo se puebla con Express `trust proxy`, nunca seteado). Detrás de cloudflared/ALB todos los
 * clientes comparten la IP del proxy → sin esto el rate-limit por IP colapsa a un cubo global.
 *
 * Verificamos que la clave que el guard envía a Redis lleve la IP de `cf-connecting-ip` (precedencia),
 * luego `x-forwarded-for` (primer hop), y por último `req.ip`/socket — consistente con admin/driver-bff.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitStore } from './rate-limiter';

/** Store en memoria que captura las claves consultadas (para inspeccionar la IP resuelta). */
function captureStore(): { store: RateLimitStore; keys: string[] } {
  const keys: string[] = [];
  const store: RateLimitStore = {
    incr: vi.fn(async (key: string) => {
      keys.push(key);
      return 1;
    }),
    pexpire: vi.fn(async () => 1),
  };
  return { store, keys };
}

/** ConfigService stub con ventana/max amplios (no es lo que se testea acá). */
const config = {
  getOrThrow: (key: string) => (key === 'RATE_LIMIT_WINDOW_MS' ? 60_000 : 1000),
} as unknown as ConfigService<never, true>;

function ctxFor(headers: Record<string, string | string[] | undefined>, ip?: string) {
  const req = { method: 'GET', url: '/x', route: { path: '/x' }, headers, ip };
  return {
    getType: () => 'http',
    getHandler: () => () => {},
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function guardWith(store: RateLimitStore): RateLimitGuard {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
  return new RateLimitGuard(reflector, store, config);
}

describe('RateLimitGuard.clientIp', () => {
  it('usa cf-connecting-ip con PRECEDENCIA sobre x-forwarded-for y req.ip', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(
      ctxFor(
        { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1, 127.0.0.1' },
        '127.0.0.1',
      ),
    );
    expect(keys[0]).toContain('203.0.113.7');
    expect(keys[0]).not.toContain('127.0.0.1');
  });

  it('cae a x-forwarded-for (primer hop) si no hay cf-connecting-ip', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({ 'x-forwarded-for': '198.51.100.5, 10.0.0.1' }, '127.0.0.1'));
    expect(keys[0]).toContain('198.51.100.5');
  });

  it('cae a req.ip cuando no hay headers de proxy', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({}, '192.0.2.42'));
    expect(keys[0]).toContain('192.0.2.42');
  });

  it('NO colapsa a un cubo global: dos clientes distintos → claves distintas', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({ 'cf-connecting-ip': '203.0.113.1' }, '127.0.0.1'));
    await guard.canActivate(ctxFor({ 'cf-connecting-ip': '203.0.113.2' }, '127.0.0.1'));
    expect(keys[0]).not.toBe(keys[1]);
  });
});
