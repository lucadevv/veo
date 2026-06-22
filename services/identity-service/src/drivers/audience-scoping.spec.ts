/**
 * Spec del SCOPING POR RIEL en HTTP (cross-rail / confused-deputy H7). Ejercita el `AudienceGuard` REAL
 * leyendo la metadata `@Audiences(...)` GENUINA aplicada a los handlers de los controllers (vía Reflector),
 * sin re-declarar los rieles esperados: si alguien cambia el riel de un endpoint, este test lo refleja.
 *
 * Por cada superficie probamos las DOS direcciones que importan: un riel PERMITIDO pasa, un riel NO
 * permitido es RECHAZADO (403 · ForbiddenError, fail-closed). Cubre 1 endpoint driver-rail, 1 admin-rail
 * y 1 public-rail (la matriz cerrada del lote).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { AudienceGuard, InternalAudience, type InternalAudience as Rail } from '@veo/auth';
import { DriversController } from './drivers.controller';
import { KycController } from '../kyc/kyc.controller';

/**
 * Arma un ExecutionContext mínimo que apunta a un HANDLER y CLASE reales (para que el Reflector lea la
 * metadata @Audiences verdadera) y carga `req.user.aud` con el riel del caller simulado.
 */
function ctxFor(
  controller: new (...args: never[]) => object,
  handler: (...args: never[]) => unknown,
  aud: Rail,
): ExecutionContext {
  const req = { user: { aud } };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AudienceGuard(new Reflector());

describe('AudienceGuard · scoping por riel HTTP (matriz cerrada del lote)', () => {
  describe('driver-rail · POST /drivers/shift/start', () => {
    const handler = DriversController.prototype.startShift;

    it('driver-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(DriversController, handler, InternalAudience.DRIVER_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('public-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(DriversController, handler, InternalAudience.PUBLIC_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });

  describe('admin-rail · POST /drivers/:id/suspend', () => {
    const handler = DriversController.prototype.suspend;

    it('admin-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(DriversController, handler, InternalAudience.ADMIN_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('driver-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(DriversController, handler, InternalAudience.DRIVER_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });

  describe('public-rail · POST /users/kyc/verify (nivel clase)', () => {
    const handler = KycController.prototype.verify;

    it('public-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(KycController, handler, InternalAudience.PUBLIC_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('admin-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(KycController, handler, InternalAudience.ADMIN_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });
});
