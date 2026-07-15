import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { Public, type PolicyReaderPort, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { PermissionOverlayGuard } from './permission-overlay.guard';
import { Permission } from './permission.decorator';

// Controller REAL decorado: el Reflector lee la metadata efectiva de handler/class (no un mock por key).
class TestController {
  @Permission('drivers:approve')
  approve(): void {}

  // Sin @Permission → el guard debe ser no-op (gap honesto · Ola B).
  noPermission(): void {}

  @Public()
  publicRoute(): void {}
}

/** Reader síncrono con overlay configurable (qué pares (rol, permiso) están RESTADOS). */
function reader(hidden: (role: string, permission: string) => boolean): PolicyReaderPort {
  return {
    numberSync: (_k, _p, fallback) => fallback,
    isPermissionHiddenSync: (role, permission) => hidden(role, permission),
  };
}

type Handler = () => void;

function ctx(handler: Handler, user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => TestController,
  } as unknown as ExecutionContext;
}

const controller = new TestController();

function userWith(...roles: AdminRole[]): AuthenticatedUser {
  return { userId: 'u1', type: 'admin', roles, sessionId: 's1' };
}

const compliance = userWith(AdminRole.COMPLIANCE_SUPERVISOR);

describe('PermissionOverlayGuard', () => {
  const reflector = new Reflector();

  it('(a) handler SIN @Permission → allow (no-op · gap honesto Ola B)', () => {
    const guard = new PermissionOverlayGuard(reflector, reader(() => true));
    expect(guard.canActivate(ctx(controller.noPermission, compliance))).toBe(true);
  });

  it('(b) @Permission + base concede + sin override → allow', () => {
    // baseGrants(COMPLIANCE_SUPERVISOR, drivers:approve) = true; overlay no resta nada.
    const guard = new PermissionOverlayGuard(reflector, reader(() => false));
    expect(guard.canActivate(ctx(controller.approve, compliance))).toBe(true);
  });

  it('(c) base concede pero overlay RESTÓ el permiso al rol del user → Forbidden', () => {
    const guard = new PermissionOverlayGuard(
      reflector,
      reader((role, perm) => role === AdminRole.COMPLIANCE_SUPERVISOR && perm === 'drivers:approve'),
    );
    expect(() => guard.canActivate(ctx(controller.approve, compliance))).toThrow(ForbiddenError);
  });

  it('(d) user con 2 roles (uno restado, otro no) → allow (efectivo = OR sobre roles)', () => {
    // ADMIN restado, COMPLIANCE_SUPERVISOR no; ambos base-conceden drivers:approve. El OR conserva P.
    const twoRoles = userWith(AdminRole.ADMIN, AdminRole.COMPLIANCE_SUPERVISOR);
    const guard = new PermissionOverlayGuard(
      reflector,
      reader((role) => role === AdminRole.ADMIN),
    );
    expect(guard.canActivate(ctx(controller.approve, twoRoles))).toBe(true);
  });

  it('(e) sin reader (undefined) → allow (fail-safe: sin overlay = base pura)', () => {
    const guard = new PermissionOverlayGuard(reflector, undefined);
    expect(guard.canActivate(ctx(controller.approve, compliance))).toBe(true);
  });

  it('(f) @Public → allow (ruta abierta, sin actor que refinar)', () => {
    const guard = new PermissionOverlayGuard(reflector, reader(() => true));
    expect(guard.canActivate(ctx(controller.publicRoute, compliance))).toBe(true);
  });

  it('sin req.user → allow (no es asunto del overlay; Jwt/Roles ya decidieron)', () => {
    const guard = new PermissionOverlayGuard(reflector, reader(() => true));
    expect(guard.canActivate(ctx(controller.approve, undefined))).toBe(true);
  });
});
