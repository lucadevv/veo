/**
 * Spec del SCOPING POR RIEL de `UsersController` (espejo de `drivers/audience-scoping.spec.ts`).
 *
 * Contexto: el controller es UNIFORME (`@Audiences(PUBLIC_RAIL)` a nivel clase), pero las operaciones a
 * nivel USER compartidas —phone-link y derecho al olvido— se abrieron TAMBIÉN al riel DRIVER con
 * `@Audiences(PUBLIC, DRIVER)` POR MÉTODO (la metadata de handler pisa la de clase vía getAllAndOverride).
 * Este spec ejercita el `AudienceGuard` REAL contra la metadata GENUINA de los handlers y fija las tres
 * direcciones que importan:
 *   1. Las 4 rutas compartidas ACEPTAN driver-rail (el gap del conductor queda cerrado).
 *   2. Las 4 rutas compartidas siguen aceptando public-rail y RECHAZAN admin-rail (fail-closed).
 *   3. El resto del controller (p. ej. PATCH /users/me, con campos passenger-only) sigue siendo
 *      PUBLIC_RAIL puro: el riel driver se RECHAZA (no se abrió de más).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { AudienceGuard, InternalAudience, type InternalAudience as Rail } from '@veo/auth';
import { UsersController } from './users.controller';

/** ExecutionContext mínimo que apunta al handler/clase REALES y carga `req.user.aud` con el riel. */
function ctxFor(handler: (...args: never[]) => unknown, aud: Rail): ExecutionContext {
  const req = { user: { aud } };
  return {
    getHandler: () => handler,
    getClass: () => UsersController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AudienceGuard(new Reflector());

/** Las 4 operaciones a nivel USER compartidas por ambos rieles de cliente. */
const SHARED_HANDLERS = [
  ['POST /users/me/phone/request', UsersController.prototype.requestPhoneLink],
  ['POST /users/me/phone/verify', UsersController.prototype.verifyPhoneLink],
  ['POST /users/me/deletion', UsersController.prototype.requestDeletion],
  ['DELETE /users/me/deletion', UsersController.prototype.cancelDeletion],
] as const;

describe('AudienceGuard · UsersController (phone-link + derecho al olvido multi-riel)', () => {
  describe.each(SHARED_HANDLERS)('%s', (_name, handler) => {
    it('driver-rail (PERMITIDO) pasa — el conductor usa el MISMO motor', () => {
      expect(guard.canActivate(ctxFor(handler, InternalAudience.DRIVER_RAIL))).toBe(true);
    });

    it('public-rail (PERMITIDO) sigue pasando — el pasajero no pierde nada', () => {
      expect(guard.canActivate(ctxFor(handler, InternalAudience.PUBLIC_RAIL))).toBe(true);
    });

    it('admin-rail (NO permitido) → 403 ForbiddenError (fail-closed)', () => {
      expect(() => guard.canActivate(ctxFor(handler, InternalAudience.ADMIN_RAIL))).toThrow(
        ForbiddenError,
      );
    });
  });

  describe('PATCH /users/me (perfil passenger-only) NO se abrió de más', () => {
    const handler = UsersController.prototype.update;

    it('public-rail (PERMITIDO, metadata de clase) pasa', () => {
      expect(guard.canActivate(ctxFor(handler, InternalAudience.PUBLIC_RAIL))).toBe(true);
    });

    it('driver-rail (NO permitido) → 403 ForbiddenError — el conductor usa su riel (me/photo, me/personal)', () => {
      expect(() => guard.canActivate(ctxFor(handler, InternalAudience.DRIVER_RAIL))).toThrow(
        ForbiddenError,
      );
    });
  });
});
