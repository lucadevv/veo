/**
 * Autorización del GobiernoController (admin-bff · CAPA 2 RBAC · ADR-024 §6). Ejercita el `RolesGuard` REAL
 * con un `Reflector` REAL leyendo la metadata `@Roles(...)` / `@RequireStepUpMfa()` GENUINA que los
 * decoradores colgaron de la clase y los métodos — sin re-declarar los roles esperados. Fija el contrato del
 * BORDE de autoridad del registro PBAC: TODO Gobierno → Políticas es EXCLUSIVO de SUPERADMIN (diseño "Solo
 * superadmin"), y MUTAR una política (PUT) exige además step-up MFA.
 *
 *  - list / get / update heredan el @Roles(SUPERADMIN) de CLASE (RolesGuard usa getAllAndOverride: sin
 *    override de método, vale el set de clase). COMPLIANCE_SUPERVISOR / ADMIN / FINANCE → 403 en TODOS.
 *  - update (PUT) lleva @RequireStepUpMfa() a nivel MÉTODO; las lecturas NO.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { RolesGuard, ROLES_KEY, REQUIRE_MFA_KEY, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { GobiernoController } from './gobierno.controller';

/** ExecutionContext mínimo apuntado al HANDLER y CLASE reales, para que el Reflector lea la metadata verdadera. */
function ctxFor(handler: (...args: never[]) => unknown, roles: AdminRole[]): ExecutionContext {
  const user: Partial<AuthenticatedUser> = { userId: 'op-1', roles };
  return {
    getHandler: () => handler,
    getClass: () => GobiernoController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const rolesGuard = new RolesGuard(new Reflector());

/** Los tres handlers del controller, para barrer el gate de clase en cada uno. */
const HANDLERS = {
  list: GobiernoController.prototype.listPolicies,
  get: GobiernoController.prototype.getPolicy,
  update: GobiernoController.prototype.updatePolicy,
} as const;

/** Roles que NO son superadmin y deben ser rechazados en TODA la superficie de Gobierno. */
const REJECTED: [string, AdminRole][] = [
  ['COMPLIANCE_SUPERVISOR', AdminRole.COMPLIANCE_SUPERVISOR],
  ['ADMIN', AdminRole.ADMIN],
  ['FINANCE', AdminRole.FINANCE],
];

describe('GobiernoController · authz — Gobierno → Políticas es EXCLUSIVO de SUPERADMIN', () => {
  describe('SUPERADMIN → ACEPTADO en list / get / update', () => {
    for (const [name, handler] of Object.entries(HANDLERS)) {
      it(`${name} → ACEPTADO`, () => {
        expect(rolesGuard.canActivate(ctxFor(handler, [AdminRole.SUPERADMIN]))).toBe(true);
      });
    }
  });

  describe('list (GET) → 403 para todo rol no-superadmin', () => {
    for (const [name, role] of REJECTED) {
      it(`${name} → RECHAZADO`, () => {
        expect(() => rolesGuard.canActivate(ctxFor(HANDLERS.list, [role]))).toThrow(ForbiddenError);
      });
    }
  });

  describe('update (PUT) → 403 para todo rol no-superadmin', () => {
    for (const [name, role] of REJECTED) {
      it(`${name} → RECHAZADO`, () => {
        expect(() => rolesGuard.canActivate(ctxFor(HANDLERS.update, [role]))).toThrow(
          ForbiddenError,
        );
      });
    }
  });

  it('la metadata @Roles de clase es EXACTAMENTE [SUPERADMIN] y ningún método la relaja', () => {
    const reflector = new Reflector();
    const classRoles = reflector.get<AdminRole[]>(ROLES_KEY, GobiernoController);
    expect(classRoles).toEqual([AdminRole.SUPERADMIN]);
    // Ningún handler declara su propio @Roles (heredan la clase) → no hay override que amplíe el set.
    for (const handler of Object.values(HANDLERS)) {
      expect(reflector.get<AdminRole[]>(ROLES_KEY, handler)).toBeUndefined();
    }
  });

  it('el PUT (update) exige step-up MFA; las lecturas NO', () => {
    const reflector = new Reflector();
    expect(reflector.get<boolean>(REQUIRE_MFA_KEY, HANDLERS.update)).toBe(true);
    expect(reflector.get<boolean>(REQUIRE_MFA_KEY, HANDLERS.list)).toBeUndefined();
    expect(reflector.get<boolean>(REQUIRE_MFA_KEY, HANDLERS.get)).toBeUndefined();
  });
});
