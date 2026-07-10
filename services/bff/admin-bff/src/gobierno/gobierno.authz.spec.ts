/**
 * Autorización del GobiernoController (admin-bff · CAPA 2 RBAC · ADR-024 §6). Ejercita el `RolesGuard` REAL
 * con un `Reflector` REAL leyendo la metadata `@Roles(...)` / `@RequireStepUpMfa()` GENUINA que los
 * decoradores colgaron de la clase y los métodos — sin re-declarar los roles esperados. Fija el contrato del
 * BORDE de autoridad del registro PBAC: TODO Gobierno → Políticas es EXCLUSIVO de SUPERADMIN (diseño "Solo
 * superadmin"), y MUTAR una política (PUT) exige además step-up MFA.
 *
 *  - list / get / update (políticas) + listOverrides / setOverride (overlay de permisos · ADR-025 §3) heredan el
 *    @Roles(SUPERADMIN) de CLASE (RolesGuard usa getAllAndOverride: sin override de método, vale el set de clase).
 *    COMPLIANCE_SUPERVISOR / ADMIN / FINANCE → 403 en TODOS.
 *  - update (PUT policy) y setOverride (PUT override) llevan @RequireStepUpMfa() a nivel MÉTODO; las lecturas NO.
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

/** Todos los handlers del controller, para barrer el gate de clase en cada uno. */
const HANDLERS = {
  list: GobiernoController.prototype.listPolicies,
  get: GobiernoController.prototype.getPolicy,
  update: GobiernoController.prototype.updatePolicy,
  listOverrides: GobiernoController.prototype.listPermissionOverrides,
  setOverride: GobiernoController.prototype.setPermissionOverride,
} as const;

/** Los dos handlers de LECTURA (GET): no exigen step-up. */
const READ_HANDLERS = {
  list: HANDLERS.list,
  get: HANDLERS.get,
  listOverrides: HANDLERS.listOverrides,
} as const;

/** Los dos handlers de MUTACIÓN (PUT): exigen step-up MFA. */
const WRITE_HANDLERS = {
  update: HANDLERS.update,
  setOverride: HANDLERS.setOverride,
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

  describe('lecturas (GET policies + overrides) → 403 para todo rol no-superadmin', () => {
    for (const [handlerName, handler] of Object.entries(READ_HANDLERS)) {
      for (const [roleName, role] of REJECTED) {
        it(`${handlerName} · ${roleName} → RECHAZADO`, () => {
          expect(() => rolesGuard.canActivate(ctxFor(handler, [role]))).toThrow(ForbiddenError);
        });
      }
    }
  });

  describe('mutaciones (PUT policy + override) → 403 para todo rol no-superadmin', () => {
    for (const [handlerName, handler] of Object.entries(WRITE_HANDLERS)) {
      for (const [roleName, role] of REJECTED) {
        it(`${handlerName} · ${roleName} → RECHAZADO`, () => {
          expect(() => rolesGuard.canActivate(ctxFor(handler, [role]))).toThrow(ForbiddenError);
        });
      }
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

  it('los PUT (update policy + setOverride) exigen step-up MFA; las lecturas NO', () => {
    const reflector = new Reflector();
    for (const handler of Object.values(WRITE_HANDLERS)) {
      expect(reflector.get<boolean>(REQUIRE_MFA_KEY, handler)).toBe(true);
    }
    for (const handler of Object.values(READ_HANDLERS)) {
      expect(reflector.get<boolean>(REQUIRE_MFA_KEY, handler)).toBeUndefined();
    }
  });
});
