/**
 * Autorización del MediaController (admin-bff · CAPA 2 RBAC). Ejercita el `RolesGuard` REAL con un
 * `Reflector` REAL leyendo la metadata `@Roles(...)` GENUINA que los decoradores colgaron de la clase y de
 * los métodos — sin re-declarar los roles esperados. Fija el contrato de SEPARACIÓN DE FUNCIONES (decisión
 * del dueño): AUTORIZAR el acceso a video grabado (dato sensible, Ley 29733) es función de CUMPLIMIENTO.
 *
 *  - `approve` (POST access-requests/:id/approve) OVERRIDE a nivel MÉTODO → COMPLIANCE_SUPERVISOR + SUPERADMIN.
 *    ADMIN puede SOLICITAR/VER pero NO APROBAR (el server lo niega). Complementa el four-eyes por IDENTIDAD
 *    (approverId ≠ requestedBy) del media-service.
 *  - `requestAccess` / `reject` heredan el @Roles amplio de la clase (incl. ADMIN): solicitar y RECHAZAR
 *    (dirección segura, no otorga acceso) no exigen la restricción de cumplimiento.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { RolesGuard, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { MediaController } from './media.controller';

/** ExecutionContext mínimo apuntado al HANDLER y CLASE reales, para que el Reflector lea la metadata verdadera. */
function ctxFor(
  handler: (...args: never[]) => unknown,
  roles: AdminRole[],
): ExecutionContext {
  const user: Partial<AuthenticatedUser> = { userId: 'op-1', roles };
  return {
    getHandler: () => handler,
    getClass: () => MediaController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const rolesGuard = new RolesGuard(new Reflector());

describe('MediaController · authz separación de funciones (media:approve)', () => {
  describe('approve → EXCLUSIVO COMPLIANCE_SUPERVISOR + SUPERADMIN (override de método)', () => {
    it('COMPLIANCE_SUPERVISOR → ACEPTADO', () => {
      const ctx = ctxFor(MediaController.prototype.approve, [AdminRole.COMPLIANCE_SUPERVISOR]);
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('SUPERADMIN → ACEPTADO', () => {
      const ctx = ctxFor(MediaController.prototype.approve, [AdminRole.SUPERADMIN]);
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('ADMIN → RECHAZADO (403 · solicita pero NO aprueba; autorizar el acceso es de cumplimiento)', () => {
      const ctx = ctxFor(MediaController.prototype.approve, [AdminRole.ADMIN]);
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });

  describe('requestAccess → ADMIN SÍ puede SOLICITAR (hereda el @Roles amplio de la clase)', () => {
    it('ADMIN → ACEPTADO', () => {
      const ctx = ctxFor(MediaController.prototype.requestAccess, [AdminRole.ADMIN]);
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('COMPLIANCE_SUPERVISOR → ACEPTADO', () => {
      const ctx = ctxFor(MediaController.prototype.requestAccess, [AdminRole.COMPLIANCE_SUPERVISOR]);
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });
  });

  describe('reject → queda con el set amplio de clase (denegar es dirección segura)', () => {
    it('ADMIN → ACEPTADO (rechazar no otorga acceso)', () => {
      const ctx = ctxFor(MediaController.prototype.reject, [AdminRole.ADMIN]);
      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });
  });

  it('la metadata @Roles de approve NO incluye ADMIN (y la de request SÍ)', () => {
    const reflector = new Reflector();
    const approveRoles = reflector.get<AdminRole[]>('veo:roles', MediaController.prototype.approve);
    const classRoles = reflector.get<AdminRole[]>('veo:roles', MediaController);
    expect(approveRoles).toEqual([AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN]);
    expect(approveRoles).not.toContain(AdminRole.ADMIN);
    expect(classRoles).toContain(AdminRole.ADMIN);
  });
});
