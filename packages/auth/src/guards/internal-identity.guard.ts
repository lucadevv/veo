/**
 * InternalIdentityGuard — se monta en los microservicios (no en el BFF).
 * Verifica el header de identidad firmado por HMAC que el BFF propaga, y adjunta el usuario.
 * Los servicios NO re-validan el JWT; confían en el BFF si la firma interna es válida.
 */
import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError, isHardenedEnv } from '@veo/utils';
import { IS_PUBLIC_KEY } from '../decorators.js';
import { INTERNAL_IDENTITY_SECRET, INTERNAL_IDENTITY_ALLOWED_AUDIENCES } from '../tokens.js';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  verifyInternalIdentity,
  type InternalAudience,
} from '../internal-identity.js';
import type { RequestWithUser } from '../jwt.js';

@Injectable()
export class InternalIdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
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
    // Ventana anti-replay: estricta (30s default) en prod. En DEV el reloj del entorno es inestable
    // (se manipula la fecha del sistema) y la firma vence falsamente → la ampliamos para no romper las
    // llamadas internas BFF→servicio. El HMAC del secreto compartido sigue protegiendo en TODOS los entornos.
    // La verificación de AUDIENCIA (fail-closed) aplica en TODOS los entornos: el caller debe pertenecer a
    // un riel que este servicio acepta, aunque el HMAC sea válido. Solo la ventana anti-replay se relaja en dev.
    const opts = {
      allowedAudiences: this.allowedAudiences,
      ...(isHardenedEnv() ? {} : { maxAgeMs: 86_400_000 }),
    };
    const identity = verifyInternalIdentity(header ?? '', sig ?? '', this.secret, opts);
    if (!identity) throw new UnauthorizedError('Identidad interna inválida o de un riel no permitido');
    req.user = identity;
    return true;
  }
}

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
