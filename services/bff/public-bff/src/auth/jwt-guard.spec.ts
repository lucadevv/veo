/** Test del guard de identidad (JwtAuthGuard de @veo/auth) tal como se monta en el BFF. */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard, type JwtService } from '@veo/auth';
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
