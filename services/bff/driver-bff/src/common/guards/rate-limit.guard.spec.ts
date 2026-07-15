import { describe, it, expect, beforeEach } from 'vitest';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { RateLimitError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';

/**
 * Doble de Redis en memoria que ejecuta el script Lua atómico de ventana fija (INCR + PEXPIRE en el
 * primer hit + PTTL). Expone `ttls` para afirmar el invariante FIX 3: la clave SIEMPRE queda con TTL.
 */
class FakeRedis {
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

const config = {
  getOrThrow: (key: string): number => (key === 'RATE_LIMIT_WINDOW_SECONDS' ? 60 : 3),
};

function ctxFor(req: Record<string, unknown>, handler: () => void = () => {}) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as never;
}

/** Aplica metadata (como hace @RateLimit) sobre un handler para que el Reflector la lea. */
function withMeta(value: RateLimitOptions | RateLimitOptions[]): () => void {
  const handler = (): void => {};
  Reflect.defineMetadata(RATE_LIMIT_KEY, value, handler);
  return handler;
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
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    guard = new RateLimitGuard(redis as never, new Reflector(), config as never);
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

  it('ATOMICIDAD: la clave SIEMPRE queda con TTL (no bucket permanente)', async () => {
    await guard.canActivate(ctxFor(makeReq()));
    // Tras el primer hit, exactamente UNA clave y con TTL > 0 (el INCR+EXPIRE atómico lo garantiza).
    expect(redis.ttls.size).toBe(1);
    for (const ttl of redis.ttls.values()) expect(ttl).toBeGreaterThan(0);
  });

  it('separa las ventanas por ruta (claves distintas no comparten contador)', async () => {
    const a = makeReq({ route: { path: '/api/v1/trips/:id' } });
    const b = makeReq({ route: { path: '/api/v1/dispatch/surge' } });
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await expect(guard.canActivate(ctxFor(a))).rejects.toBeInstanceOf(RateLimitError);
    await expect(guard.canActivate(ctxFor(b))).resolves.toBe(true);
  });

  it('SEGURIDAD: un x-forwarded-for inyectado NO da cubo fresco — la IP real (req.ip) manda', async () => {
    const real = makeReq({ user: undefined, ip: '203.0.113.7' });
    await guard.canActivate(ctxFor({ ...real, headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await guard.canActivate(ctxFor({ ...real, headers: { 'x-forwarded-for': '2.2.2.2' } }));
    await guard.canActivate(ctxFor({ ...real, headers: { 'x-forwarded-for': '3.3.3.3' } }));
    await expect(
      guard.canActivate(ctxFor({ ...real, headers: { 'x-forwarded-for': '4.4.4.4' } })),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('tráfico legítimo: clientes con req.ip distinta no comparten contador', async () => {
    const a = makeReq({ user: undefined, ip: '203.0.113.1' });
    const b = makeReq({ user: undefined, ip: '203.0.113.2' });
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await guard.canActivate(ctxFor(a));
    await expect(guard.canActivate(ctxFor(a))).rejects.toBeInstanceOf(RateLimitError);
    await expect(guard.canActivate(ctxFor(b))).resolves.toBe(true);
  });

  describe('FIX 6 · override @RateLimit POR MÉTODO (ADR-012)', () => {
    it('aplica el límite estricto del decorator (5) en vez del global', async () => {
      // Global = 3, pero el override permite 5 antes de bloquear.
      const handler = withMeta({ max: 5, windowMs: 600_000, by: ['ip', 'phone'] });
      const req = makeReq({ user: undefined, ip: '5.5.5.5', body: { phone: '987654321' } });
      for (let i = 0; i < 5; i++) {
        await expect(guard.canActivate(ctxFor(req, handler))).resolves.toBe(true);
      }
      await expect(guard.canActivate(ctxFor(req, handler))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('by:[ip,phone] separa contadores por teléfono (misma IP)', async () => {
      const handler = withMeta({ max: 1, windowMs: 600_000, by: ['ip', 'phone'] });
      const mk = (phone: string) =>
        ctxFor(makeReq({ user: undefined, ip: '4.4.4.4', body: { phone } }), handler);
      await expect(guard.canActivate(mk('900000001'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('900000002'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('900000001'))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('el cubo del override es independiente del cubo global (no se mezclan)', async () => {
      const handler = withMeta({ max: 1, windowMs: 600_000, by: ['ip'] });
      const req = makeReq({ user: undefined, ip: '6.6.6.6', body: {} });
      // Agota el override (max 1).
      await guard.canActivate(ctxFor(req, handler));
      await expect(guard.canActivate(ctxFor(req, handler))).rejects.toBeInstanceOf(RateLimitError);
      // La MISMA req sin override (cubo global, max 3) sigue disponible: cubos separados.
      await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    });
  });

  describe('FIX A · @RateLimit con ARREGLO de límites (cap fino IP+phone Y cap AGREGADO por-IP)', () => {
    // Espeja la prod: 5/ventana por IP+teléfono Y un techo agregado por-IP (acá 20) sobre el fan-out.
    const dual = (perIpMax: number): (() => void) =>
      withMeta([
        { max: 5, windowMs: 600_000, by: ['ip', 'phone'] },
        { max: perIpMax, windowMs: 600_000, by: ['ip'] },
      ]);

    it('una IP fija NO puede disparar SMS a N teléfonos sin techo: la 21ª request → 429', async () => {
      const handler = dual(20);
      const mk = (phone: string) =>
        ctxFor(
          makeReq({
            user: undefined,
            ip: '7.7.7.7',
            method: 'POST',
            route: { path: '/auth/otp/request' },
            body: { phone },
          }),
          handler,
        );
      // 20 requests a 20 teléfonos DISTINTOS: cada uno pasa el cap fino (1<5) pero suma al cap por-IP.
      for (let i = 1; i <= 20; i++) {
        await expect(guard.canActivate(mk(`90000${String(i).padStart(4, '0')}`))).resolves.toBe(
          true,
        );
      }
      // La 21ª, a un teléfono NUEVO (cap fino lo permitiría), choca con el cap AGREGADO por-IP → 429.
      await expect(guard.canActivate(mk('900099999'))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('el cap fino por IP+teléfono sigue cortando el retry del MISMO número (6ª al mismo phone → 429)', async () => {
      const handler = dual(100); // cap por-IP holgado para aislar el cap fino.
      const mk = () =>
        ctxFor(
          makeReq({
            user: undefined,
            ip: '8.8.8.8',
            method: 'POST',
            route: { path: '/auth/otp/request' },
            body: { phone: '900000001' },
          }),
          handler,
        );
      for (let i = 0; i < 5; i++) await expect(guard.canActivate(mk())).resolves.toBe(true);
      await expect(guard.canActivate(mk())).rejects.toBeInstanceOf(RateLimitError);
    });

    it('usuario legítimo: 1-2 OTP del mismo número NO se bloquean (ni cap fino ni agregado)', async () => {
      const handler = dual(20);
      const mk = () =>
        ctxFor(
          makeReq({
            user: undefined,
            ip: '9.9.9.9',
            method: 'POST',
            route: { path: '/auth/otp/request' },
            body: { phone: '900000123' },
          }),
          handler,
        );
      await expect(guard.canActivate(mk())).resolves.toBe(true);
      await expect(guard.canActivate(mk())).resolves.toBe(true);
    });
  });

  describe('FIX 1 · canonicalización del teléfono antes de keyear (anti bypass Nx del cap fino)', () => {
    // El DTO acepta el MISMO número peruano en 3 formas. Sin canonicalizar abrían 3 cubos → 3x el cap.
    const handler = (max: number): (() => void) =>
      withMeta({ max, windowMs: 600_000, by: ['ip', 'phone'] });

    it('las 3 representaciones del MISMO número comparten cubo (cap 5 → la 6ª en cualquier forma → 429)', async () => {
      const h = handler(5);
      const [bare, cc, e164] = ['987654321', '51987654321', '+51987654321'];
      const mk = (phone: string) =>
        ctxFor(
          makeReq({
            user: undefined,
            ip: '11.11.11.11',
            method: 'POST',
            route: { path: '/auth/otp/request' },
            body: { phone },
          }),
          h,
        );
      // 5 hits repartidos entre las 3 formas: si NO colapsaran, ninguna llegaría a 5.
      await expect(guard.canActivate(mk(bare))).resolves.toBe(true); // 987654321
      await expect(guard.canActivate(mk(cc))).resolves.toBe(true); // 51987654321
      await expect(guard.canActivate(mk(e164))).resolves.toBe(true); // +51987654321
      await expect(guard.canActivate(mk(bare))).resolves.toBe(true);
      await expect(guard.canActivate(mk(cc))).resolves.toBe(true);
      // 6ª (en una 3ra forma) → mismo cubo agotado → 429.
      await expect(guard.canActivate(mk(e164))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('la forma canónica es +51XXXXXXXXX (espacios/guiones se ignoran, mismo cubo)', async () => {
      const h = handler(1);
      const mk = (phone: string) =>
        ctxFor(makeReq({ user: undefined, ip: '12.12.12.12', body: { phone } }), h);
      await expect(guard.canActivate(mk('987 654 321'))).resolves.toBe(true);
      // '+51-987-654-321' canoniza al MISMO +51987654321 → cubo (max 1) agotado → 429.
      await expect(guard.canActivate(mk('+51-987-654-321'))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('números DISTINTOS siguen en cubos distintos (no colapsa de más)', async () => {
      const h = handler(1);
      const mk = (phone: string) =>
        ctxFor(makeReq({ user: undefined, ip: '13.13.13.13', body: { phone } }), h);
      await expect(guard.canActivate(mk('987654321'))).resolves.toBe(true);
      await expect(guard.canActivate(mk('987654322'))).resolves.toBe(true);
    });
  });
});
