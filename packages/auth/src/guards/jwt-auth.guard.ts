/**
 * JwtAuthGuard — valida el access token (Bearer) y adjunta el usuario al request.
 * Se monta en los BFFs (decisión: validación en el gateway). Respeta @Public().
 */
import {
  Injectable,
  Inject,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError } from '@veo/utils';
import { IS_PUBLIC_KEY } from '../decorators.js';
import { EXPECTED_SUBJECT_TYPE, JWT_SERVICE } from '../tokens.js';
import {
  type JwtService,
  type RequestWithUser,
  type SubjectType,
  toAuthenticatedUser,
} from '../jwt.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JWT_SERVICE) private readonly jwt: JwtService,
    // Opcional: si la app lo provee (p.ej. admin-bff → 'admin'), se rechaza cualquier token de otro typ.
    @Optional() @Inject(EXPECTED_SUBJECT_TYPE) private readonly expectedType?: SubjectType,
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
    // Defensa en profundidad: si el BFF declara un typ esperado, un token de otro sujeto NO entra
    // (no depende solo del RBAC). Sin expectedType configurado, no cambia el comportamiento.
    if (this.expectedType && claims.typ !== this.expectedType) {
      throw new UnauthorizedError('Token no autorizado para este servicio');
    }
    req.user = toAuthenticatedUser(claims);
    return true;
  }
}
