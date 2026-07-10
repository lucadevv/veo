import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ForbiddenError, SystemClock } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type { PolicyReader } from '@veo/policy';
import { AdminRole } from '@veo/shared-types';
import { PolicyStepUpMfaGuard } from './policy-step-up-mfa.guard';
import { REQUIRE_MFA_FOR_POLICY_KEY } from './require-step-up-for-policy.decorator';

const user: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: [AdminRole.COMPLIANCE_SUPERVISOR],
  sessionId: 's1',
};

function reflector(marked: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) =>
      key === REQUIRE_MFA_FOR_POLICY_KEY && marked ? 'pii.reveal-stepup' : undefined,
  } as unknown as Reflector;
}

function fakePolicy(enabled: boolean, maxAgeSec = 600): PolicyReader {
  return {
    getEnabled: async () => enabled,
    number: async (_k, _p, fallback) => (maxAgeSec ?? fallback),
    bool: async (_k, _p, fallback) => fallback,
    list: async (_k, _p, fallback) => fallback,
    params: async () => ({}),
  };
}

function ctx(u?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const freshUser: AuthenticatedUser = { ...user, mfaVerifiedAt: Math.floor(Date.now() / 1000) };
const staleUser: AuthenticatedUser = {
  ...user,
  mfaVerifiedAt: Math.floor(Date.now() / 1000) - 3600, // 1h atrás (> 600s)
};

describe('PolicyStepUpMfaGuard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('handler no marcado → pasa (no aplica)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new PolicyStepUpMfaGuard(reflector(false), new SystemClock(), fakePolicy(true));
    await expect(guard.canActivate(ctx(staleUser))).resolves.toBe(true);
  });

  it('policy enabled + MFA vieja (> maxAgeSec) → 403 (entorno endurecido)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new PolicyStepUpMfaGuard(reflector(true), new SystemClock(), fakePolicy(true, 600));
    await expect(guard.canActivate(ctx(staleUser))).rejects.toThrow(ForbiddenError);
  });

  it('policy enabled + MFA fresca → pasa', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new PolicyStepUpMfaGuard(reflector(true), new SystemClock(), fakePolicy(true, 600));
    await expect(guard.canActivate(ctx(freshUser))).resolves.toBe(true);
  });

  it('policy disabled (default) → pasa sin step-up (solo RBAC)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new PolicyStepUpMfaGuard(reflector(true), new SystemClock(), fakePolicy(false));
    await expect(guard.canActivate(ctx(staleUser))).resolves.toBe(true);
  });

  it('entorno NO endurecido (dev) → pasa aunque enabled + MFA vieja (mismo bypass que StepUpMfaGuard)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const guard = new PolicyStepUpMfaGuard(reflector(true), new SystemClock(), fakePolicy(true, 600));
    await expect(guard.canActivate(ctx(staleUser))).resolves.toBe(true);
  });
});
