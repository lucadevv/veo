/**
 * Enforcement del BARRIDO endpoint→permiso (ADR-025 Ola B): prueba que el guard bloquea usando la metadata
 * REAL declarada en los controllers (no un controller de juguete). Complementa a `permission-overlay.guard.spec`
 * (que prueba la lógica del guard en aislamiento): acá probamos que el barrido efectivamente CABLEÓ los
 * endpoints al overlay — reflejando `@Permission` sobre los handlers reales y drivándolos por el guard.
 *
 * El invariante que sostiene todo el barrido: para CADA endpoint mapeado, `PERMISSION_ROLES[P] ⊇ @Roles` — así
 * el guard (que corre DESPUÉS del RolesGuard y solo RESTA) nunca niega por debajo de la base sin un override.
 */
import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { ROLES_KEY, type PolicyReaderPort, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { baseGrants, PERMISSION_ROLES, type Permission } from '@veo/policy';
import { PermissionOverlayGuard } from './permission-overlay.guard';
import { PERMISSION_KEY } from './permission.decorator';
import { OpsController } from '../ops/ops.controller';
import { GobiernoController } from '../gobierno/gobierno.controller';
import { FinanceController } from '../finance/finance.controller';

/** Reader síncrono con overlay configurable (qué pares (rol, permiso) están RESTADOS). */
function reader(hidden: (role: string, permission: string) => boolean): PolicyReaderPort {
  return {
    numberSync: (_k, _p, fallback) => fallback,
    isPermissionHiddenSync: (role, permission) => hidden(role, permission),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown;

function ctx(handler: Handler, controllerClass: unknown, user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => controllerClass,
  } as unknown as ExecutionContext;
}

function userWith(...roles: AdminRole[]): AuthenticatedUser {
  return { userId: 'u1', type: 'admin', roles, sessionId: 's1' };
}

describe('PermissionOverlayGuard · enforcement del barrido (metadata REAL de los controllers)', () => {
  const reflector = new Reflector();

  it('el barrido cableó OpsController.approveDriver → @Permission(drivers:approve)', () => {
    const perm = reflector.get<string>(PERMISSION_KEY, OpsController.prototype.approveDriver);
    expect(perm).toBe('drivers:approve');
  });

  it('endpoint REAL (approveDriver) + overlay RESTÓ drivers:approve al rol del user → 403', () => {
    const compliance = userWith(AdminRole.COMPLIANCE_SUPERVISOR);
    const guard = new PermissionOverlayGuard(
      reflector,
      reader((role, perm) => role === AdminRole.COMPLIANCE_SUPERVISOR && perm === 'drivers:approve'),
    );
    expect(() =>
      guard.canActivate(ctx(OpsController.prototype.approveDriver, OpsController, compliance)),
    ).toThrow(ForbiddenError);
  });

  it('mismo endpoint SIN override → pasa (base concede, overlay no resta)', () => {
    const compliance = userWith(AdminRole.COMPLIANCE_SUPERVISOR);
    const guard = new PermissionOverlayGuard(reflector, reader(() => false));
    expect(
      guard.canActivate(ctx(OpsController.prototype.approveDriver, OpsController, compliance)),
    ).toBe(true);
  });

  it('@Permission a NIVEL DE CLASE: GobiernoController.listPolicies hereda gobierno:manage y el overlay lo bloquea', () => {
    // listPolicies no redeclara @Permission → getAllAndOverride cae a la clase (gobierno:manage).
    const superadmin = userWith(AdminRole.SUPERADMIN);
    const blocking = new PermissionOverlayGuard(
      reflector,
      reader((role, perm) => role === AdminRole.SUPERADMIN && perm === 'gobierno:manage'),
    );
    expect(() =>
      blocking.canActivate(ctx(GobiernoController.prototype.listPolicies, GobiernoController, superadmin)),
    ).toThrow(ForbiddenError);
    // Sin override, pasa.
    const passing = new PermissionOverlayGuard(reflector, reader(() => false));
    expect(
      passing.canActivate(ctx(GobiernoController.prototype.listPolicies, GobiernoController, superadmin)),
    ).toBe(true);
  });

  it('user con 2 roles: uno restado, otro conserva el permiso → pasa (efectivo = OR sobre roles)', () => {
    // FinanceController.refund → finance:refund. FINANCE restado, ADMIN no; ambos base-conceden → el OR conserva.
    const twoRoles = userWith(AdminRole.FINANCE, AdminRole.ADMIN);
    const guard = new PermissionOverlayGuard(
      reflector,
      reader((role) => role === AdminRole.FINANCE),
    );
    expect(guard.canActivate(ctx(FinanceController.prototype.refund, FinanceController, twoRoles))).toBe(
      true,
    );
  });

  /**
   * Guardia del INVARIANTE del barrido: cada handler con @Permission mapea a un permiso cuyo set base de roles
   * CONTIENE a los @Roles del handler (o los de su clase, si el método no redeclara). Si algún mapeo violara
   * `PERMISSION_ROLES[P] ⊇ @Roles`, el overlay negaría por debajo de la base sin override → regresión silenciosa.
   * Este test recorre los controllers cableados y lo verifica endpoint por endpoint.
   */
  it('INVARIANTE base ⊇ @Roles para cada endpoint mapeado (evita 403 espurios)', () => {
    const controllers = [OpsController, GobiernoController, FinanceController];
    const violations: string[] = [];

    for (const Ctrl of controllers) {
      const proto = Ctrl.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const permission = reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
          handler as Handler,
          Ctrl,
        ]);
        if (!permission) continue;
        const roles = reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
          handler as Handler,
          Ctrl,
        ]);
        for (const role of roles ?? []) {
          if (!baseGrants(role, permission)) {
            violations.push(`${Ctrl.name}.${name} → @Permission('${permission}') no concede a @Roles ${role}`);
          }
        }
      }
    }

    expect(PERMISSION_ROLES).toBeDefined();
    expect(violations).toEqual([]);
  });
});
