import { describe, it, expect } from 'vitest';
import { consumeFixedWindow, type RateLimitRedis } from './rate-limit.js';

/**
 * Fake de Redis que EJECUTA el script Lua de ventana fija de forma equivalente (INCR + PEXPIRE solo
 * en el primer hit + PTTL), atómicamente como lo haría Redis. Expone `ttls` para afirmar el invariante
 * crítico: una clave existente SIEMPRE tiene TTL (imposible un bucket permanente).
 */
class FakeRedis implements RateLimitRedis {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();

  eval(_script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    // Espeja el script real: PTTL == -1 ⇔ clave existente SIN TTL (PTTL devuelve -1; -2 sería
    // inexistente, pero el INCR ya la creó). El PEXPIRE se fija en el primer hit O cuando la key no
    // tiene TTL (saneo de legacy). Atómico (mismo `eval`) → la clave SIEMPRE termina con TTL.
    const ttl = this.ttls.has(key) ? (this.ttls.get(key) as number) : -1;
    if (count === 1 || ttl === -1) this.ttls.set(key, windowMs);
    return Promise.resolve([count, this.ttls.get(key) ?? -1]);
  }
}

describe('consumeFixedWindow', () => {
  it('permite hasta el máximo y luego bloquea (allowed=false)', async () => {
    const redis = new FakeRedis();
    const r1 = await consumeFixedWindow(redis, 'k', 3, 60_000);
    const r2 = await consumeFixedWindow(redis, 'k', 3, 60_000);
    const r3 = await consumeFixedWindow(redis, 'k', 3, 60_000);
    const r4 = await consumeFixedWindow(redis, 'k', 3, 60_000);
    expect([r1.allowed, r2.allowed, r3.allowed, r4.allowed]).toEqual([true, true, true, false]);
    expect(r3.remaining).toBe(0);
    expect(r4.count).toBe(4);
  });

  it('cuentas independientes por clave', async () => {
    const redis = new FakeRedis();
    expect((await consumeFixedWindow(redis, 'a', 1, 60_000)).allowed).toBe(true);
    expect((await consumeFixedWindow(redis, 'b', 1, 60_000)).allowed).toBe(true);
    expect((await consumeFixedWindow(redis, 'a', 1, 60_000)).allowed).toBe(false);
  });

  it('ATOMICIDAD: la clave SIEMPRE queda con TTL tras el primer hit (no bucket permanente)', async () => {
    const redis = new FakeRedis();
    await consumeFixedWindow(redis, 'k', 5, 30_000);
    // El invariante que el INCR+EXPIRE no atómico rompía: aquí TTL existe sí o sí.
    expect(redis.ttls.get('k')).toBe(30_000);
    expect(redis.ttls.has('k')).toBe(true);
  });

  it('expone resetMs (PTTL) para el Retry-After', async () => {
    const redis = new FakeRedis();
    const r = await consumeFixedWindow(redis, 'k', 5, 45_000);
    expect(r.resetMs).toBe(45_000);
  });

  it('el TTL se fija SOLO en el primer hit (ventana FIJA, no se reinicia por request)', async () => {
    const redis = new FakeRedis();
    await consumeFixedWindow(redis, 'k', 5, 60_000);
    // Simula el paso del tiempo bajando el TTL (como haría Redis): un segundo hit NO debe re-fijarlo.
    redis.ttls.set('k', 12_345);
    await consumeFixedWindow(redis, 'k', 5, 60_000);
    expect(redis.ttls.get('k')).toBe(12_345); // intacto: no se reinició la ventana
  });

  it('FIX C: una key LEGACY sin TTL (PTTL=-1) recibe TTL en el próximo hit (saneo, no bucket permanente)', async () => {
    const redis = new FakeRedis();
    // Simula una key preexistente de un deploy anterior: count ya alto y SIN TTL (-1) por un EXPIRE
    // perdido. Sin el saneo, esta key con count>max bloquearía al cliente PARA SIEMPRE.
    redis.counts.set('legacy', 99);
    // (ttls no tiene la key → el fake la trata como PTTL=-1)
    expect(redis.ttls.has('legacy')).toBe(false);
    const r = await consumeFixedWindow(redis, 'legacy', 5, 30_000);
    // El hit la saneó: ahora tiene TTL > 0 y resetMs lo refleja → eventualmente expira y se desbloquea.
    expect(redis.ttls.get('legacy')).toBe(30_000);
    expect(r.resetMs).toBe(30_000);
    expect(r.allowed).toBe(false); // sigue bloqueada AHORA (count 100 > 5), pero ya con caducidad
  });

  it('un EVAL que devuelve enteros como string igual se normaliza a number', async () => {
    const stringyRedis: RateLimitRedis = {
      eval: () => Promise.resolve(['2', '5000']),
    };
    const r = await consumeFixedWindow(stringyRedis, 'k', 5, 5000);
    expect(r.count).toBe(2);
    expect(r.resetMs).toBe(5000);
    expect(r.allowed).toBe(true);
  });
});
