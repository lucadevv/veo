import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard, StepUpMfaGuard, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';
import { AdminRole } from '@veo/shared-types';

function reflectorReturning(value: unknown): Reflector {
  return { getAllAndOverride: () => value } as unknown as Reflector;
}

function ctxWithUser(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const financeUser: AuthenticatedUser = {
  userId: 'u1',
  type: 'admin',
  roles: [AdminRole.FINANCE],
  sessionId: 's1',
};

describe('RolesGuard (RBAC)', () => {
  it('permite si el usuario tiene alguno de los roles requeridos', () => {
    const guard = new RolesGuard(reflectorReturning([AdminRole.FINANCE, AdminRole.ADMIN]));
    expect(guard.canActivate(ctxWithUser(financeUser))).toBe(true);
  });

  it('rechaza (Forbidden) si el rol es insuficiente', () => {
    const guard = new RolesGuard(reflectorReturning([AdminRole.SUPERADMIN]));
    expect(() => guard.canActivate(ctxWithUser(financeUser))).toThrow(ForbiddenError);
  });

  it('permite si el endpoint no exige roles', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));
    expect(guard.canActivate(ctxWithUser(financeUser))).toBe(true);
  });
});

describe('StepUpMfaGuard', () => {
  // El step-up SOLO endurece en entorno ENDURECIDO (isHardenedEnv = NODE_ENV=production: preview+prod).
  // En dev/local se RELAJA (menos fricción). Los casos de enforcement fijan el entorno endurecido.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('permite cuando no se exige step-up', () => {
    const guard = new StepUpMfaGuard(reflectorReturning(false));
    expect(guard.canActivate(ctxWithUser(financeUser))).toBe(true);
  });

  it('rechaza si se exige step-up y la MFA no es fresca (entorno endurecido)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new StepUpMfaGuard(reflectorReturning(true));
    expect(() => guard.canActivate(ctxWithUser(financeUser))).toThrow(ForbiddenError);
  });

  it('permite si se exige step-up y la MFA es reciente (entorno endurecido)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new StepUpMfaGuard(reflectorReturning(true));
    const fresh: AuthenticatedUser = {
      ...financeUser,
      mfaVerifiedAt: Math.floor(Date.now() / 1000),
    };
    expect(guard.canActivate(ctxWithUser(fresh))).toBe(true);
  });

  it('en DEV (no endurecido) se RELAJA: permite aunque se exija step-up sin MFA fresca', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const guard = new StepUpMfaGuard(reflectorReturning(true));
    expect(guard.canActivate(ctxWithUser(financeUser))).toBe(true);
  });
});
