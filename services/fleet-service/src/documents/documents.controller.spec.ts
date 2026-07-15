/**
 * Autorización del DocumentsController (CAPA 2 RBAC, FOUNDATION §14). Verifica, con los guards REALES y un
 * `Reflector` real leyendo la metadata REAL aplicada por los decoradores del controller, que:
 *  - FIX A · `list` (GET /documents) es ADMIN-ONLY: expone PII de cualquier dueño (incl. `extractedData`
 *    OCR: DNI/SOAT/licencia). Un principal sin rol admin → ForbiddenError (403); un admin → pasa.
 *  - `create` (POST /documents) NO se rompió: conserva su `@Audiences(DRIVER_RAIL, ADMIN_RAIL)`, así que el
 *    conductor (driver-rail) sigue pudiendo subir SUS documentos.
 * Sin string mágico: los roles salen del enum `AdminRole`; las audiencias de `InternalAudience`.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import {
  RolesGuard,
  AudienceGuard,
  type AuthenticatedUser,
  InternalAudience,
  type InternalIdentity,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DocumentsController } from './documents.controller';

/**
 * `ExecutionContext` mínimo apuntado al handler REAL del controller (`controller[method]`), para que el
 * `Reflector` real resuelva la metadata que los decoradores `@Roles`/`@Audiences` colgaron del método.
 */
function contextFor(
  controller: DocumentsController,
  method: 'list' | 'create',
  user: AuthenticatedUser | InternalIdentity | undefined,
): never {
  const handler = controller[method] as (...args: unknown[]) => unknown;
  return {
    getHandler: () => handler,
    getClass: () => DocumentsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

function adminUser(roles: AdminRole[]): AuthenticatedUser {
  return { userId: 'op-1', type: 'admin', roles, sessionId: 's1' };
}

function railIdentity(aud: InternalAudience): InternalIdentity {
  return { userId: 'd-1', type: 'driver', roles: [], sessionId: 's1', issuedAt: Date.now(), aud };
}

describe('DocumentsController · autorización (RBAC + audiencia)', () => {
  const reflector = new Reflector();
  const controller = new DocumentsController({} as never);
  const rolesGuard = new RolesGuard(reflector);
  const audienceGuard = new AudienceGuard(reflector);

  describe('FIX A · GET /documents (list) es ADMIN-ONLY', () => {
    it('RECHAZA: principal SIN rol admin → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'list', adminUser([]));
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });

    it('RECHAZA: rol no-admin (SUPPORT_L1) → ForbiddenError (403)', () => {
      const ctx = contextFor(controller, 'list', adminUser([AdminRole.SUPPORT_L1]));
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

    it('usa EXACTAMENTE los mismos roles admin que `review` (mismo controller, sin string mágico)', () => {
      const listRoles = reflector.get<AdminRole[]>('veo:roles', controller.list);
      const reviewRoles = reflector.get<AdminRole[]>('veo:roles', controller.review);
      expect(listRoles).toEqual(reviewRoles);
      expect(listRoles).toEqual([
        AdminRole.COMPLIANCE_SUPERVISOR,
        AdminRole.ADMIN,
        AdminRole.SUPERADMIN,
      ]);
    });
  });

  describe('create (POST /documents) NO se rompió con el FIX A', () => {
    it('PASA: driver-rail (el conductor sube SUS docs) cruza el AudienceGuard', () => {
      const ctx = contextFor(controller, 'create', railIdentity(InternalAudience.DRIVER_RAIL));
      expect(audienceGuard.canActivate(ctx)).toBe(true);
    });

    it('PASA: admin-rail (operador) cruza el AudienceGuard', () => {
      const ctx = contextFor(controller, 'create', railIdentity(InternalAudience.ADMIN_RAIL));
      expect(audienceGuard.canActivate(ctx)).toBe(true);
    });

    it('`create` NO tiene metadata de @Roles (no quedó ADMIN-ONLY por error)', () => {
      const createRoles = reflector.get<AdminRole[] | undefined>('veo:roles', controller.create);
      expect(createRoles).toBeUndefined();
    });
  });
});
