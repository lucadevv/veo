/**
 * Autorización del MediaController (media-service · defensa en profundidad, CAPA 3). Ejercita el `RolesGuard`
 * REAL con un `Reflector` REAL leyendo la metadata `@Roles(...)` GENUINA de cada handler — sin re-declarar los
 * roles esperados. Fija el contrato de SEPARACIÓN DE FUNCIONES (decisión del dueño): AUTORIZAR el acceso a
 * video grabado (dato sensible, Ley 29733) es función de CUMPLIMIENTO.
 *
 *  - `approve` (POST access/:id/approve) → COMPLIANCE_SUPERVISOR + SUPERADMIN. ADMIN puede SOLICITAR pero NO
 *    APROBAR (el server lo niega). Re-declara el gate que el admin-bff ya aplica (defensa en profundidad).
 *    Complementa el four-eyes por IDENTIDAD (approveAccess: approverId ≠ requestedBy).
 *  - `reject` (POST access/:id/reject) queda con el set amplio (incl. ADMIN): RECHAZAR deniega acceso
 *    (dirección segura, no otorga dato sensible), así que no exige la restricción de cumplimiento.
 *  - `stream` / `listAccessRequests` / `segments` conservan COMPLIANCE + ADMIN + SUPERADMIN.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { RolesGuard, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { MediaController } from './media.controller';

function ctxFor(handler: (...args: never[]) => unknown, roles: AdminRole[]): ExecutionContext {
  const user: Partial<AuthenticatedUser> = { userId: 'op-1', roles };
  return {
    getHandler: () => handler,
    getClass: () => MediaController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const rolesGuard = new RolesGuard(new Reflector());

describe('MediaController (media-service) · authz separación de funciones (approve)', () => {
  describe('approve → EXCLUSIVO COMPLIANCE_SUPERVISOR + SUPERADMIN', () => {
    it('COMPLIANCE_SUPERVISOR → ACEPTADO', () => {
      expect(rolesGuard.canActivate(ctxFor(MediaController.prototype.approve, [AdminRole.COMPLIANCE_SUPERVISOR]))).toBe(true);
    });

    it('SUPERADMIN → ACEPTADO', () => {
      expect(rolesGuard.canActivate(ctxFor(MediaController.prototype.approve, [AdminRole.SUPERADMIN]))).toBe(true);
    });

    it('ADMIN → RECHAZADO (403 · autorizar el acceso a video es función de cumplimiento)', () => {
      expect(() => rolesGuard.canActivate(ctxFor(MediaController.prototype.approve, [AdminRole.ADMIN]))).toThrow(ForbiddenError);
    });
  });

  describe('reject → set amplio (denegar es dirección segura)', () => {
    it('ADMIN → ACEPTADO (rechazar no otorga acceso)', () => {
      expect(rolesGuard.canActivate(ctxFor(MediaController.prototype.reject, [AdminRole.ADMIN]))).toBe(true);
    });
  });

  it('metadata @Roles: approve = [COMPLIANCE, SUPERADMIN] (sin ADMIN); reject conserva ADMIN', () => {
    const reflector = new Reflector();
    const approveRoles = reflector.get<AdminRole[]>('veo:roles', MediaController.prototype.approve);
    const rejectRoles = reflector.get<AdminRole[]>('veo:roles', MediaController.prototype.reject);
    expect(approveRoles).toEqual([AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN]);
    expect(approveRoles).not.toContain(AdminRole.ADMIN);
    expect(rejectRoles).toContain(AdminRole.ADMIN);
  });
});
