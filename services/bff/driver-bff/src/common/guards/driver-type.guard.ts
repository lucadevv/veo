/**
 * DriverTypeGuard — tras JwtAuthGuard, exige que el sujeto autenticado sea de tipo 'driver'.
 * Respeta @Public(). Garantiza que la app de pasajero/admin no use el driver-bff.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, type RequestWithUser } from '@veo/auth';
import { ForbiddenError } from '@veo/utils';

@Injectable()
export class DriverTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (req.user?.type !== 'driver') {
      throw new ForbiddenError('Este BFF es exclusivo para conductores');
    }
    return true;
  }
}
