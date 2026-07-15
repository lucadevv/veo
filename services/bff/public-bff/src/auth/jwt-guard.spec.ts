/** Test del guard de identidad (JwtAuthGuard de @veo/auth) tal como se monta en el BFF. */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard, type JwtService, type SubjectType } from '@veo/auth';
import { UnauthorizedError } from '@veo/utils';

function ctxWith(
  headers: Record<string, string>,
  handler = () => {},
): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req = { headers } as { headers: Record<string, string>; user?: unknown };
  const ctx = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

const claims = { sub: 'u1', typ: 'passenger' as const, roles: [], sid: 'sess-1' };
const jwt = { verifyAccess: vi.fn().mockResolvedValue(claims) } as unknown as JwtService;

describe('JwtAuthGuard', () => {
  it('deja pasar endpoints @Public sin validar token', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const guard = new JwtAuthGuard(reflector, jwt);
    const { ctx } = ctxWith({});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rechaza si falta el Bearer', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const guard = new JwtAuthGuard(reflector, jwt);
    const { ctx } = ctxWith({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('valida el token y adjunta el usuario al request', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const guard = new JwtAuthGuard(reflector, jwt);
    const { ctx, req } = ctxWith({ authorization: 'Bearer abc.def.ghi' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ userId: 'u1', type: 'passenger', sessionId: 'sess-1' });
  });
});

/**
 * Escopado del subject-type 'passenger' tal como lo monta public-bff (EXPECTED_SUBJECT_TYPE).
 * Un token de conductor/admin (misma firma/aud/iss válidos) NO debe entrar a rutas de pasajero.
 */
describe('JwtAuthGuard · public-bff escopa typ=passenger', () => {
  const EXPECTED: SubjectType = 'passenger';

  function guardFor(tokenTyp: SubjectType) {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const jwtForTyp = {
      verifyAccess: vi
        .fn()
        .mockResolvedValue({ sub: 'u1', typ: tokenTyp, roles: [], sid: 'sess-1' }),
    } as unknown as JwtService;
    // 4º arg = expectedType, igual que el provider EXPECTED_SUBJECT_TYPE='passenger' en app.module.
    return new JwtAuthGuard(reflector, jwtForTyp, EXPECTED);
  }

  it('rechaza un token de conductor (typ=driver) en rutas de pasajero', async () => {
    const guard = guardFor('driver');
    const { ctx } = ctxWith({ authorization: 'Bearer driver.tok' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza un token de admin (typ=admin) en rutas de pasajero', async () => {
    const guard = guardFor('admin');
    const { ctx } = ctxWith({ authorization: 'Bearer admin.tok' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('acepta un token de pasajero (typ=passenger)', async () => {
    const guard = guardFor('passenger');
    const { ctx, req } = ctxWith({ authorization: 'Bearer pax.tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ type: 'passenger' });
  });
});
