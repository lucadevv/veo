/**
 * Autorización del InspectionsController (CAPA 2 RBAC). El RolesGuard va a NIVEL DE CLASE: TODOS los
 * endpoints —`create` (POST) y `list` (GET)— exigen un rol de operador. El FIX cierra el hueco previo:
 * el GET quedaba solo bajo InternalIdentityGuard → cualquier identidad interna firmada (driver-rail/
 * service-rail) listaba TODAS las inspecciones. Se prueba con los guards REALES y un `Reflector` real
 * leyendo la metadata que los decoradores colgaron del controller. Sin string mágico: roles del enum.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import {
  RolesGuard,
  type AuthenticatedUser,
  InternalAudience,
  type InternalIdentity,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { InspectionsController } from './inspections.controller';

/**
 * `ExecutionContext` mínimo apuntado al handler REAL del controller, para que el `Reflector` resuelva la
 * metadata `@Roles` colgada a nivel de CLASE (getAllAndOverride mira [handler, class]).
 */
function contextFor(
  controller: InspectionsController,
  method: 'list' | 'create',
  user: AuthenticatedUser | InternalIdentity | undefined,
): never {
  const handler = controller[method] as (...args: unknown[]) => unknown;
  return {
    getHandler: () => handler,
    getClass: () => InspectionsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

function adminUser(roles: AdminRole[]): AuthenticatedUser {
  return { userId: 'op-1', type: 'admin', roles, sessionId: 's1' };
}

/** Identidad interna firmada SIN roles admin (lo que trae un driver-rail/service-rail). */
function railIdentity(aud: InternalAudience): InternalIdentity {
  return { userId: 'd-1', type: 'driver', roles: [], sessionId: 's1', issuedAt: Date.now(), aud };
}

describe('InspectionsController · autorización (RBAC a nivel de clase)', () => {
  const reflector = new Reflector();
  const controller = new InspectionsController({} as never);
  const rolesGuard = new RolesGuard(reflector);

  describe('FIX 4 · GET /inspections (list) exige rol de operador', () => {
    it('RECHAZA: identidad interna firmada SIN rol (driver-rail) → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'list', railIdentity(InternalAudience.DRIVER_RAIL));
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });

    it('RECHAZA: service-rail sin rol → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'list', railIdentity(InternalAudience.SERVICE_RAIL));
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });

    it('RECHAZA: admin autenticado pero sin roles → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'list', adminUser([]));
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });

    it('PASA: COMPLIANCE_SUPERVISOR → true (200)', () => {
      const ctx = contextFor(controller, 'list', adminUser([AdminRole.COMPLIANCE_SUPERVISOR]));
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('PASA: ADMIN → true (200)', () => {
      const ctx = contextFor(controller, 'list', adminUser([AdminRole.ADMIN]));
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('PASA: SUPERADMIN → true (200)', () => {
      const ctx = contextFor(controller, 'list', adminUser([AdminRole.SUPERADMIN]));
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });
  });

  describe('POST /inspections (create) conserva el MISMO gate de roles', () => {
    it('RECHAZA: sin rol → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'create', railIdentity(InternalAudience.DRIVER_RAIL));
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });

    it('list y create exigen EXACTAMENTE los mismos roles de operador (gate de clase, sin divergencia)', () => {
      const listRoles = reflector.getAllAndOverride<AdminRole[]>('veo:roles', [
        controller.list as never,
        InspectionsController,
      ]);
      const createRoles = reflector.getAllAndOverride<AdminRole[]>('veo:roles', [
        controller.create as never,
        InspectionsController,
      ]);
      expect(listRoles).toEqual(createRoles);
      expect(listRoles).toEqual([
        AdminRole.COMPLIANCE_SUPERVISOR,
        AdminRole.ADMIN,
        AdminRole.SUPERADMIN,
      ]);
    });
  });
});
