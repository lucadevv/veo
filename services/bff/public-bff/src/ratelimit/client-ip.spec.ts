/**
 * SEGURIDAD (rate-limit) — la IP del cliente se resuelve de `req.ip`, que Express puebla vía
 * `trust proxy` (ver main.ts): camina el `X-Forwarded-For` descartando los hops de proxy de confianza
 * (ALB + ingress-nginx, IP privada) y deja la primera IP PÚBLICA = el cliente real.
 *
 * El contrato CAMBIÓ: antes el guard leía `cf-connecting-ip`/`x-forwarded-for` CRUDOS (spoofeables);
 * ahora lee `req.ip`. Acá verificamos que un header de IP INYECTADO por el atacante NO entra en la
 * clave de Redis (no obtiene un cubo de rate-limit fresco rotando el header) y que el rate-limit
 * sigue funcionando para tráfico legítimo (misma req.ip → misma clave; clientes distintos → distintas).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitStore } from './rate-limiter';

/**
 * Store en memoria que captura las claves consultadas (para inspeccionar la IP resuelta). El limiter
 * llama `eval(script, 1, key, windowMs)`: la clave es el 3er argumento posicional (KEYS[1]).
 */
function captureStore(): { store: RateLimitStore; keys: string[] } {
  const keys: string[] = [];
  const store: RateLimitStore = {
    eval: vi.fn(async (_script: string, _numKeys: number, ...args: Array<string | number>) => {
      keys.push(String(args[0]));
      return [1, 60_000];
    }),
  };
  return { store, keys };
}

/** ConfigService stub con ventana/max amplios (no es lo que se testea acá). */
const config = {
  getOrThrow: (key: string) => (key === 'RATE_LIMIT_WINDOW_MS' ? 60_000 : 1000),
} as unknown as ConfigService<never, true>;

/**
 * Construye el ExecutionContext. `ip` es lo que Express resolvió vía trust proxy (la IP real del
 * cliente); `headers` es lo que el cliente mandó (potencialmente inyectado por un atacante).
 */
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

describe('RateLimitGuard.clientIp · req.ip (trust proxy), headers crudos NO ganan', () => {
  it('SEGURIDAD: cf-connecting-ip y x-forwarded-for inyectados NO ganan sobre req.ip', async () => {
    // Simula el chain del ALB: trust proxy ya dejó req.ip = la IP pública real (203.0.113.7).
    // El atacante inyectó cf-connecting-ip y x-forwarded-for con OTRA IP para forjar un cubo fresco.
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(
      ctxFor({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }, '203.0.113.7'),
    );
    expect(keys[0]).toContain('203.0.113.7'); // la IP REAL
    expect(keys[0]).not.toContain('1.2.3.4'); // la IP inyectada NO entra en la clave
  });

  it('SEGURIDAD: rotar x-forwarded-for NO da cubo fresco — misma req.ip → MISMA clave', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({ 'x-forwarded-for': '9.9.9.1' }, '203.0.113.7'));
    await guard.canActivate(ctxFor({ 'x-forwarded-for': '9.9.9.2' }, '203.0.113.7'));
    expect(keys[0]).toBe(keys[1]); // el atacante NO evade el límite cambiando el header
  });

  it('usa req.ip (la IP real que resolvió Express) cuando no hay headers', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({}, '192.0.2.42'));
    expect(keys[0]).toContain('192.0.2.42');
  });

  it('tráfico legítimo: dos clientes reales distintos (req.ip) → claves distintas', async () => {
    const { store, keys } = captureStore();
    const guard = guardWith(store);
    await guard.canActivate(ctxFor({}, '203.0.113.1'));
    await guard.canActivate(ctxFor({}, '203.0.113.2'));
    expect(keys[0]).not.toBe(keys[1]);
  });
});
