import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from '@veo/auth';
import { DriverTypeGuard } from './driver-type.guard';

function contextWith(user: AuthenticatedUser | undefined, isPublic = false) {
  const reflector = new Reflector();
  // Simula la metadata @Public en el handler.
  const handler = (): void => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  const ctx = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
  return { reflector, ctx };
}

describe('DriverTypeGuard', () => {
  const driver: AuthenticatedUser = { userId: 'u1', type: 'driver', roles: [], sessionId: 's1' };
  const passenger: AuthenticatedUser = {
    userId: 'u2',
    type: 'passenger',
    roles: [],
    sessionId: 's2',
  };

  it('permite a un usuario de tipo driver', () => {
    const { reflector, ctx } = contextWith(driver);
    const guard = new DriverTypeGuard(reflector);
    expect(guard.canActivate(ctx as never)).toBe(true);
  });

  it('rechaza a un pasajero con ForbiddenError', () => {
    const { reflector, ctx } = contextWith(passenger);
    const guard = new DriverTypeGuard(reflector);
    expect(() => guard.canActivate(ctx as never)).toThrow(ForbiddenError);
  });

  it('rechaza si no hay usuario', () => {
    const { reflector, ctx } = contextWith(undefined);
    const guard = new DriverTypeGuard(reflector);
    expect(() => guard.canActivate(ctx as never)).toThrow(ForbiddenError);
  });

  it('deja pasar endpoints @Public sin validar tipo', () => {
    const { reflector, ctx } = contextWith(undefined, true);
    const guard = new DriverTypeGuard(reflector);
    expect(guard.canActivate(ctx as never)).toBe(true);
  });
});
