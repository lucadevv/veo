/**
 * Tests del helper de deduplicación at-least-once (`processEventOnce`):
 *  - ejecuta el handler una sola vez por eventId,
 *  - marca el dedup DESPUÉS del éxito (un fallo NO marca → el reintento re-ejecuta),
 *  - respeta keyPrefix (aislamiento por servicio) y TTL configurable.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_DEDUP_TTL_SECONDS, processEventOnce, type DedupRedis } from './dedup.js';

function makeRedis(): { redis: DedupRedis; store: Map<string, string>; ttls: number[] } {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  const redis: DedupRedis = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, _mode, ttlSeconds) => {
      store.set(key, value);
      ttls.push(ttlSeconds);
      return 'OK';
    },
  };
  return { redis, store, ttls };
}

const OPTS = { keyPrefix: 'veo:test:evt:' };

describe('processEventOnce', () => {
  it('ejecuta el handler y devuelve su resultado la primera vez', async () => {
    const { redis } = makeRedis();
    const fn = vi.fn(async () => 42);

    const outcome = await processEventOnce(redis, OPTS, 'evt-1', fn);

    expect(outcome).toEqual({ executed: true, result: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('NO re-ejecuta el handler para el mismo eventId (duplicado)', async () => {
    const { redis } = makeRedis();
    const fn = vi.fn(async () => 42);

    await processEventOnce(redis, OPTS, 'evt-1', fn);
    const outcome = await processEventOnce(redis, OPTS, 'evt-1', fn);

    expect(outcome).toEqual({ executed: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('NO marca el dedup si el handler falla: el reintento re-ejecuta', async () => {
    const { redis, store } = makeRedis();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('transitorio');
      return 'ok';
    });

    await expect(processEventOnce(redis, OPTS, 'evt-1', fn)).rejects.toThrow('transitorio');
    expect(store.size).toBe(0); // la marca NO se escribió

    const retry = await processEventOnce(redis, OPTS, 'evt-1', fn);
    expect(retry).toEqual({ executed: true, result: 'ok' });
    expect(calls).toBe(2);
  });

  it('aísla por keyPrefix: el mismo eventId en otro namespace SÍ se procesa', async () => {
    const { redis } = makeRedis();
    const fn = vi.fn(async () => 'ok');

    await processEventOnce(redis, { keyPrefix: 'veo:a:evt:' }, 'evt-1', fn);
    const other = await processEventOnce(redis, { keyPrefix: 'veo:b:evt:' }, 'evt-1', fn);

    expect(other.executed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('usa el TTL por defecto (24h) y respeta uno explícito', async () => {
    const { redis, ttls } = makeRedis();

    await processEventOnce(redis, OPTS, 'evt-1', async () => 1);
    await processEventOnce(redis, { ...OPTS, ttlSeconds: 60 }, 'evt-2', async () => 1);

    expect(ttls).toEqual([DEFAULT_DEDUP_TTL_SECONDS, 60]);
  });
});
