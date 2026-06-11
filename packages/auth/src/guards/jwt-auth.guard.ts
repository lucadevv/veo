/**
 * JwtAuthGuard — valida el access token (Bearer) y adjunta el usuario al request.
 * Se monta en los BFFs (decisión: validación en el gateway). Respeta @Public().
 */
import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError } from '@veo/utils';
import { IS_PUBLIC_KEY } from '../decorators.js';
import { JWT_SERVICE } from '../tokens.js';
import { type JwtService, type RequestWithUser, toAuthenticatedUser } from '../jwt.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JWT_SERVICE) private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const auth = req.headers.authorization;
    const header = Array.isArray(auth) ? auth[0] : auth;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Falta el token Bearer');
    }
    const claims = await this.jwt.verifyAccess(header.slice(7));
    req.user = toAuthenticatedUser(claims);
    return true;
  }
}
