/**
 * JwtAuthGuard · validación opcional de `typ` (defensa en profundidad): si la app provee
 * EXPECTED_SUBJECT_TYPE (p.ej. admin-bff → 'admin'), un token de otro sujeto NO entra aunque la firma
 * sea válida. Sin expectedType, el comportamiento NO cambia (backward-compatible).
 */
import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { SubjectType } from '../jwt.js';

function context(authHeader?: string) {
  const req = { headers: { authorization: authHeader }, user: undefined };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

const reflector = { getAllAndOverride: () => false } as never; // ruta NO pública

function makeGuard(tokenTyp: SubjectType, expectedType?: SubjectType) {
  const jwt = {
    verifyAccess: vi.fn(async () => ({ sub: 'u1', typ: tokenTyp, roles: [], sid: 's1' })),
  } as never;
  return new JwtAuthGuard(reflector, jwt, expectedType);
}

describe('JwtAuthGuard · expectedType', () => {
  it('rechaza un token de otro typ cuando expectedType está configurado (admin-bff → admin)', async () => {
    const guard = makeGuard('passenger', 'admin');
    await expect(guard.canActivate(context('Bearer tok'))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('acepta el token del typ esperado', async () => {
    const guard = makeGuard('admin', 'admin');
    await expect(guard.canActivate(context('Bearer tok'))).resolves.toBe(true);
  });

  it('sin expectedType configurado, acepta cualquier typ (backward-compatible)', async () => {
    const guard = makeGuard('passenger', undefined);
    await expect(guard.canActivate(context('Bearer tok'))).resolves.toBe(true);
  });
});
