/**
 * RolesGuard — RBAC para el panel admin (7 roles, BR-S07).
 * Debe correr DESPUÉS de un guard que adjunte req.user (Jwt o InternalIdentity).
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import type { AdminRole } from '@veo/shared-types';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators.js';
import type { AuthenticatedUser } from '../jwt.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      // Fail-closed: una ruta que corre bajo el RolesGuard y NO declara @Roles solo se permite si es
      // @Public (login/health/csrf/ws-ticket/refresh — abierta a propósito, mismo key que JwtAuthGuard).
      // Cualquier otra ruta autenticada sin @Roles es un footgun → 403 hasta que declare sus roles.
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) return true;
      throw new ForbiddenError('Ruta sin @Roles declarado (fail-closed)');
    }

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user || !required.some((r) => user.roles.includes(r))) {
      throw new ForbiddenError('Rol insuficiente', { required });
    }
    return true;
  }
}
