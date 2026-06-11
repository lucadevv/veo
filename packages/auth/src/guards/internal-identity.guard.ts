/**
 * InternalIdentityGuard — se monta en los microservicios (no en el BFF).
 * Verifica el header de identidad firmado por HMAC que el BFF propaga, y adjunta el usuario.
 * Los servicios NO re-validan el JWT; confían en el BFF si la firma interna es válida.
 */
import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError } from '@veo/utils';
import { IS_PUBLIC_KEY } from '../decorators.js';
import { INTERNAL_IDENTITY_SECRET } from '../tokens.js';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  verifyInternalIdentity,
} from '../internal-identity.js';
import type { RequestWithUser } from '../jwt.js';

@Injectable()
export class InternalIdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const header = pick(req.headers[INTERNAL_IDENTITY_HEADER]);
    const sig = pick(req.headers[INTERNAL_IDENTITY_SIG_HEADER]);
    const identity = verifyInternalIdentity(header ?? '', sig ?? '', this.secret);
    if (!identity) throw new UnauthorizedError('Identidad interna inválida');
    req.user = identity;
    return true;
  }
}

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
