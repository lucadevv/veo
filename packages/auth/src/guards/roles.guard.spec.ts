/**
 * RolesGuard · fail-closed (RBAC BR-S07). Una ruta que corre bajo el guard y NO declara @Roles solo
 * pasa si es @Public; cualquier otra ruta autenticada sin @Roles cae en 403 (footgun cerrado). Cuando
 * SÍ hay @Roles, la lógica de match por rol no cambia.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import type { AdminRole } from '@veo/shared-types';
import { RolesGuard } from './roles.guard.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators.js';

function context(roles?: AdminRole[]) {
  const req = { user: roles === undefined ? undefined : { roles } };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

/** Reflector falso: responde según el key consultado (ROLES_KEY / IS_PUBLIC_KEY). */
function reflectorWith(opts: { roles?: AdminRole[]; isPublic?: boolean }) {
  return {
    getAllAndOverride: (key: string) => {
      if (key === ROLES_KEY) return opts.roles;
      if (key === IS_PUBLIC_KEY) return opts.isPublic ?? false;
      return undefined;
    },
  } as never;
}

describe('RolesGuard · fail-closed', () => {
  it('(a) sin @Roles y NO @Public → ForbiddenError (fail-closed)', () => {
    const guard = new RolesGuard(reflectorWith({}));
    expect(() => guard.canActivate(context(['SUPERADMIN']))).toThrow(ForbiddenError);
  });

  it('(b) sin @Roles pero @Public → permite (abierto a propósito)', () => {
    const guard = new RolesGuard(reflectorWith({ isPublic: true }));
    expect(guard.canActivate(context())).toBe(true);
  });

  it('(c) con @Roles y el usuario tiene un rol que matchea → permite', () => {
    const guard = new RolesGuard(reflectorWith({ roles: ['SUPERADMIN', 'DISPATCHER'] as AdminRole[] }));
    expect(guard.canActivate(context(['DISPATCHER'] as AdminRole[]))).toBe(true);
  });

  it('(d) con @Roles y el usuario NO tiene rol que matchea → ForbiddenError', () => {
    const guard = new RolesGuard(reflectorWith({ roles: ['SUPERADMIN'] as AdminRole[] }));
    expect(() => guard.canActivate(context(['DISPATCHER'] as AdminRole[]))).toThrow(ForbiddenError);
  });

  it('con @Roles pero sin usuario en el request → ForbiddenError', () => {
    const guard = new RolesGuard(reflectorWith({ roles: ['SUPERADMIN'] as AdminRole[] }));
    expect(() => guard.canActivate(context())).toThrow(ForbiddenError);
  });
});
