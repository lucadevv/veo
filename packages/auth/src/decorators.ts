/**
 * Decorators de autorización (FOUNDATION §7).
 */
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AdminRole } from '@veo/shared-types';
import type { AuthenticatedUser } from './jwt.js';

export const IS_PUBLIC_KEY = 'veo:isPublic';
export const ROLES_KEY = 'veo:roles';
export const REQUIRE_MFA_KEY = 'veo:requireMfa';

/** Marca un endpoint como público (sin auth). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Restringe a los roles admin indicados (BR-S07 RBAC). */
export const Roles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Exige verificación MFA fresca (step-up) para acciones sensibles. */
export const RequireStepUpMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_MFA_KEY, true);

/** Inyecta el usuario autenticado en un parámetro del handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return req.user;
  },
);
