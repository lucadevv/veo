import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from '@veo/auth';
import type { PolicyReader } from '@veo/policy';
import { AdminRole } from '@veo/shared-types';
import { IpAllowlistGuard } from './ip-allowlist.guard';

const superadmin: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: [AdminRole.SUPERADMIN],
  sessionId: 's1',
};

/** PolicyReader falso: solo enabled + cidrs importan para este guard. */
function fakePolicy(opts: { enabled: boolean; cidrs: string[] }): PolicyReader {
  return {
    getEnabled: async () => opts.enabled,
    list: async (_k, _p, fallback) => (opts.cidrs.length ? opts.cidrs : fallback),
    number: async (_k, _p, fallback) => fallback,
    bool: async (_k, _p, fallback) => fallback,
    params: async () => ({}),
  };
}

function reflector(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC_KEY ? isPublic : undefined),
  } as unknown as Reflector;
}

function ctx(opts: { ip?: string; user?: AuthenticatedUser }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip: opts.ip, user: opts.user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('IpAllowlistGuard', () => {
  it('enabled + CIDR que incluye la IP → pasa', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: true, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ ip: '10.1.2.3', user: superadmin }))).resolves.toBe(true);
  });

  it('enabled + CIDR que NO incluye la IP → 403', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: true, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ ip: '172.16.0.1', user: superadmin }))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('disabled → pasa (fail-safe, aunque la IP no matchee)', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: false, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ ip: '172.16.0.1', user: superadmin }))).resolves.toBe(true);
  });

  it('cidrs vacío → pasa (fail-safe: no lockout del superadmin)', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: true, cidrs: [] }));
    await expect(guard.canActivate(ctx({ ip: '172.16.0.1', user: superadmin }))).resolves.toBe(true);
  });

  it('@Public queda exento (no consulta la política)', async () => {
    const guard = new IpAllowlistGuard(reflector(true), fakePolicy({ enabled: true, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ ip: '172.16.0.1' }))).resolves.toBe(true);
  });

  it('sin req.user → pasa (nada que restringir)', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: true, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ ip: '172.16.0.1' }))).resolves.toBe(true);
  });

  it('enabled + IP no resoluble → 403 (secure-by-default)', async () => {
    const guard = new IpAllowlistGuard(reflector(false), fakePolicy({ enabled: true, cidrs: ['10.0.0.0/8'] }));
    await expect(guard.canActivate(ctx({ user: superadmin }))).rejects.toThrow(ForbiddenError);
  });
});
