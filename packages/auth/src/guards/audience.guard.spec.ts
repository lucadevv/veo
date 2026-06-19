/**
 * AudienceGuard · acota por AUDIENCIA DE RIEL (transporte, FOUNDATION §14). Fail-closed: una identidad
 * de un riel no requerido se RECHAZA aunque su HMAC sea válido (defensa contra confused deputy). Sin
 * metadata @Audiences → no-op (deja pasar; el endpoint no declara restricción de riel).
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import { AudienceGuard } from './audience.guard.js';
import { InternalAudience, type InternalIdentity } from '../internal-identity.js';

function context(aud?: InternalAudience) {
  const user: InternalIdentity | undefined =
    aud === undefined
      ? undefined
      : { userId: 'u1', type: 'driver', roles: [], sessionId: 's1', issuedAt: Date.now(), aud };
  const req = { user };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

function makeGuard(required?: InternalAudience[]) {
  const reflector = { getAllAndOverride: () => required } as never;
  return new AudienceGuard(reflector);
}

describe('AudienceGuard', () => {
  it('PASA: la audiencia del caller está entre las requeridas', () => {
    const guard = makeGuard([InternalAudience.DRIVER_RAIL, InternalAudience.ADMIN_RAIL]);
    expect(guard.canActivate(context(InternalAudience.DRIVER_RAIL))).toBe(true);
  });

  it('RECHAZA: aud=service-rail con @Audiences(driver, admin) → ForbiddenError (fail-closed)', () => {
    const guard = makeGuard([InternalAudience.DRIVER_RAIL, InternalAudience.ADMIN_RAIL]);
    expect(() => guard.canActivate(context(InternalAudience.SERVICE_RAIL))).toThrow(ForbiddenError);
  });

  it('RECHAZA: identidad sin aud (ausente) → ForbiddenError', () => {
    const guard = makeGuard([InternalAudience.DRIVER_RAIL]);
    expect(() => guard.canActivate(context(undefined))).toThrow(ForbiddenError);
  });

  it('NO-OP: sin metadata @Audiences (undefined) → true (el endpoint no restringe riel)', () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(context(InternalAudience.SERVICE_RAIL))).toBe(true);
  });

  it('NO-OP: metadata @Audiences vacía → true', () => {
    const guard = makeGuard([]);
    expect(guard.canActivate(context(InternalAudience.SERVICE_RAIL))).toBe(true);
  });
});
