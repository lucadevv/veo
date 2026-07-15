/**
 * SessionRevocationGuard — enforcement HTTP de la revocación de sesión.
 *
 * Corre DESPUÉS de `JwtAuthGuard` (que valida la firma y puebla `req.user`): consulta el denylist en Redis
 * y, si la sesión está revocada, lanza `SessionRevokedError` (401). NO re-verifica el JWT ni lo vuelve
 * async (respeta el `verifyAccess` sync existente): solo lee la identidad ya adjuntada al request.
 *
 * Orden de montaje esperado en el BFF: JwtAuthGuard → (DriverTypeGuard) → SessionRevocationGuard.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { RequestWithUser } from '../jwt.js';
import { SessionRevocationStore } from '../session-revocation.js';

@Injectable()
export class SessionRevocationGuard implements CanActivate {
  constructor(private readonly revocation: SessionRevocationStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    // Sin identidad = ruta @Public (JwtAuthGuard devolvió true sin poblar req.user) → nada que revocar.
    if (!user) return true;
    await this.revocation.assertNotRevoked({
      sub: user.userId,
      sid: user.sessionId,
      iat: user.issuedAtSec,
    });
    return true;
  }
}
