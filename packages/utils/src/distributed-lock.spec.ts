/**
 * withDistributedLock — el contrato exacto que los crons del monorepo tenían copy-pasteado:
 * SET NX EX → 'OK' ejecuta, cualquier otra cosa skipea sin ejecutar; release opcional por DEL.
 */
import { describe, it, expect, vi } from 'vitest';
import { withDistributedLock, type DistributedLockClient } from './distributed-lock.js';

function makeRedis(reply: string | null = 'OK'): {
  redis: DistributedLockClient;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const set = vi.fn(async () => reply);
  const del = vi.fn(async () => 1);
  return { redis: { set, del }, set, del };
}

describe('withDistributedLock · adquisición', () => {
  it("adquiere con SET key '1' EX ttl NX y ejecuta fn devolviendo su resultado", async () => {
    const { redis, set } = makeRedis('OK');
    const outcome = await withDistributedLock(redis, 'veo:test:lock', 600, async () => 42);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('veo:test:lock', '1', 'EX', 600, 'NX');
    expect(outcome).toEqual({ acquired: true, result: 42 });
  });

  it('lock tomado por otra réplica (null) → NO ejecuta fn y devuelve acquired=false', async () => {
    const { redis } = makeRedis(null);
    const fn = vi.fn(async () => 42);
    const outcome = await withDistributedLock(redis, 'veo:test:lock', 600, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ acquired: false });
  });

  it('skip → invoca onSkip (el log de skip lo decide el caller; default silencioso)', async () => {
    const { redis } = makeRedis(null);
    const onSkip = vi.fn();
    await withDistributedLock(redis, 'veo:test:lock', 600, async () => undefined, { onSkip });
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe('withDistributedLock · liberación', () => {
  it('default (lock-hasta-TTL): NO hace DEL al terminar', async () => {
    const { redis, del } = makeRedis('OK');
    await withDistributedLock(redis, 'veo:test:lock', 600, async () => undefined);
    expect(del).not.toHaveBeenCalled();
  });

  it('releaseOnSettle: libera con DEL al terminar fn con éxito', async () => {
    const { redis, del } = makeRedis('OK');
    await withDistributedLock(redis, 'veo:test:lock', 600, async () => undefined, {
      releaseOnSettle: true,
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('veo:test:lock');
  });

  it('releaseOnSettle: libera con DEL aunque fn falle, y el error de fn SE PROPAGA', async () => {
    const { redis, del } = makeRedis('OK');
    const boom = new Error('barrido falló');
    await expect(
      withDistributedLock(
        redis,
        'veo:test:lock',
        600,
        async () => {
          throw boom;
        },
        { releaseOnSettle: true },
      ),
    ).rejects.toThrow(boom);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('veo:test:lock');
  });

  it('un DEL que falla NO tapa el resultado de fn (el lock expira por TTL)', async () => {
    const set = vi.fn(async () => 'OK');
    const del = vi.fn(async () => {
      throw new Error('conexión caída');
    });
    const redis = { set, del } as unknown as DistributedLockClient;

    const outcome = await withDistributedLock(redis, 'veo:test:lock', 600, async () => 'hecho', {
      releaseOnSettle: true,
    });
    expect(outcome).toEqual({ acquired: true, result: 'hecho' });
  });
});
