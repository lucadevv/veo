/**
 * AdminIdentityGuard (ADR 011 §6 · defensa en profundidad) — corre DESPUÉS del InternalIdentityGuard
 * (que ya verificó la firma HMAC del header y adjuntó `req.user`). Re-valida que la identidad firmada
 * sea de tipo `admin`: el RBAC fino `pricing:manage` se aplica en admin-bff, pero trip-service NO confía
 * ciegamente en cualquier llamador interno firmado — exige que sea un admin para MUTAR el schedule.
 * Rechaza con 403 si no lo es. Se usa SOLO en el PUT (mutación); el GET/resolve aceptan cualquier
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
      throw new ForbiddenError('Solo una identidad admin puede editar el schedule de pricing (ADR 011 §6)');
    }
    return true;
  }
}
