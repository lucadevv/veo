import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Clock } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type { PolicyReader } from '@veo/policy';
import { AdminRole } from '@veo/shared-types';
import { SessionIdleGuard, SessionIdleTimeoutError } from './session-idle.guard';

const user: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: [AdminRole.SUPERADMIN],
  sessionId: 'sid-1',
};

const KEY = 'veo:admin:session:lastseen:sid-1';

/** Redis en memoria (solo get/set/del). `failing:true` hace que toda operación rechace. */
function fakeRedis(seed: Record<string, string> = {}, failing = false) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: vi.fn(async (k: string) => (failing ? Promise.reject(new Error('redis down')) : store.get(k) ?? null)),
    set: vi.fn(async (k: string, v: string) => {
      if (failing) throw new Error('redis down');
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    _store: store,
  } as unknown as Redis & { _store: Map<string, string>; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

function fakePolicy(enabled: boolean, idleMin = 30): PolicyReader {
  return {
    getEnabled: async () => enabled,
    number: async (_k, _p, fallback) => (idleMin ?? fallback),
    bool: async (_k, _p, fallback) => fallback,
    list: async (_k, _p, fallback) => fallback,
    isPermissionHidden: async () => false,
    params: async () => ({}),
  };
}

function clockAt(nowMs: number): Clock {
  return { now: () => nowMs } as Clock;
}

function ctx(u?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('SessionIdleGuard', () => {
  it('dentro de idleMin → pasa y REFRESCA lastActivity', async () => {
    const now = 1_000_000; // seg
    const redis = fakeRedis({ [KEY]: String(now - 5 * 60) }); // últ. actividad hace 5 min (< 30)
    const guard = new SessionIdleGuard(redis, fakePolicy(true, 30), clockAt(now * 1000));
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(KEY, String(now), 'EX', expect.any(Number));
    expect(redis._store.get(KEY)).toBe(String(now));
  });

  it('excede idleMin (enabled) → rechaza (idle timeout)', async () => {
    const now = 1_000_000;
    const redis = fakeRedis({ [KEY]: String(now - 31 * 60) }); // hace 31 min (> 30)
    const guard = new SessionIdleGuard(redis, fakePolicy(true, 30), clockAt(now * 1000));
    await expect(guard.canActivate(ctx(user))).rejects.toThrow(SessionIdleTimeoutError);
    expect(redis.del).toHaveBeenCalledWith(KEY);
  });

  it('disabled → pasa aunque exceda, y NO toca Redis', async () => {
    const now = 1_000_000;
    const redis = fakeRedis({ [KEY]: String(now - 999 * 60) });
    const guard = new SessionIdleGuard(redis, fakePolicy(false, 30), clockAt(now * 1000));
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('primera actividad (sin lastseen previo) → pasa y setea', async () => {
    const now = 1_000_000;
    const redis = fakeRedis({});
    const guard = new SessionIdleGuard(redis, fakePolicy(true, 30), clockAt(now * 1000));
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
    expect(redis._store.get(KEY)).toBe(String(now));
  });

  it('sin req.user → pasa (nada que trackear)', async () => {
    const redis = fakeRedis({});
    const guard = new SessionIdleGuard(redis, fakePolicy(true, 30), clockAt(1_000_000_000));
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(true);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('Redis caído → pasa (fail-safe a disponibilidad, no trabar la sesión)', async () => {
    const now = 1_000_000;
    const redis = fakeRedis({}, true);
    const guard = new SessionIdleGuard(redis, fakePolicy(true, 30), clockAt(now * 1000));
    await expect(guard.canActivate(ctx(user))).resolves.toBe(true);
  });
});
