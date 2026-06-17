/**
 * AdminIdentityGuard (defensa en profundidad · espejo del trip-service) — corre DESPUÉS del
 * InternalIdentityGuard (que ya verificó la firma HMAC del header y adjuntó `req.user`). Re-valida que la
 * identidad firmada sea de tipo `admin`: el RBAC fino se aplica en admin-bff, pero dispatch-service NO
 * confía ciegamente en cualquier llamador interno firmado — exige que sea un admin para MUTAR la config
 * de radios. Rechaza con 403 si no lo es. Se usa SOLO en el PUT (mutación); el GET acepta cualquier
 * identidad interna firmada (lectura).
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import type { RequestWithUser } from '@veo/auth';

@Injectable()
export class AdminIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    if (user?.type !== 'admin') {
      throw new ForbiddenError(
        'Solo una identidad admin puede editar la config de radios de dispatch',
      );
    }
    return true;
  }
}
