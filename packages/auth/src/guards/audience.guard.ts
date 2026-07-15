/**
 * AudienceGuard — acota un endpoint a las AUDIENCIAS DE RIEL aceptadas (transporte, FOUNDATION §14).
 * Espejo de RolesGuard, pero filtra por el riel emisor (`InternalIdentity.aud`) en vez de por rol.
 * Debe correr DESPUÉS de InternalIdentityGuard (que adjunta `req.user` con el `aud` firmado por HMAC).
 *
 * Defensa de transporte (confused deputy): aunque el HMAC sea válido, una identidad emitida por un
 * riel no autorizado para esta operación se RECHAZA (fail-closed). Sin metadata @Audiences → no-op.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { AUDIENCES_KEY } from '../decorators.js';
import type { InternalAudience, InternalIdentity } from '../internal-identity.js';

@Injectable()
export class AudienceGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<InternalAudience[] | undefined>(
      AUDIENCES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: InternalIdentity }>();
    const aud = req.user?.aud;
    if (!aud || !required.includes(aud)) {
      throw new ForbiddenError('Riel no autorizado para esta operación', { required });
    }
    return true;
  }
}
