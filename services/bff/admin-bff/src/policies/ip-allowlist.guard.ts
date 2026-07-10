/**
 * IpAllowlistGuard — enforcement de la política `access.ip-allowlist` (PBAC · ADR-024 §4b/§5 · Fase 2 NET-NEW).
 *
 * Restringe el acceso admin a rangos CIDR autorizados. Corre DESPUÉS de `JwtAuthGuard` (necesita `req.user`
 * para saber que hay una sesión autenticada) y ANTES del RateLimit/RBAC: una IP no autorizada se corta temprano.
 *
 * REGLA DE ORO PBAC (nunca fail-open, nunca lockout accidental · ADR §4):
 *   • `@Public` (login/health/refresh) queda EXENTO — igual que el RolesGuard, vía `IS_PUBLIC_KEY`.
 *   • Sin `req.user` (sonda/anónimo) → ALLOW (no hay sesión que restringir).
 *   • Política `enabled=false` O `cidrs` VACÍO → ALLOW (fail-safe: una allowlist apagada/vacía NUNCA deja
 *     afuera al superadmin). Es el default del catálogo (NET-NEW arranca disabled).
 *   • enabled + cidrs no vacío → se resuelve la IP REAL del cliente (`req.ip`, ya saneada por `trust proxy`
 *     en main.ts — NO el XFF crudo spoofeable) y se EXIGE match; si no matchea (o la IP no se puede resolver)
 *     → 403 ForbiddenError.
 *
 * Lee del `PolicyReader` async (cache Kafka-invalidada de `@veo/policy`): un cambio del superadmin surte
 * efecto sin redeploy. Si el reader/cache está frío, el reader mismo cae al DEFAULT del catálogo (disabled →
 * ALLOW): fail-safe extremo a extremo.
 */
import {
  Injectable,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@veo/utils';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from '@veo/auth';
import { POLICY_READER, type PolicyReader } from '@veo/policy';
import { ipInAnyCidr } from './cidr';

interface RequestLike {
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: AuthenticatedUser;
}

@Injectable()
export class IpAllowlistGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_READER) private readonly policy: PolicyReader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // @Public exento (mismo criterio que RolesGuard): login/health/refresh no se restringen por IP.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestLike>();
    // Sin identidad (sonda/anónimo tras un guard que no pobló req.user) → nada que restringir.
    if (!req.user) return true;

    // Fail-safe: política apagada → ALLOW (NET-NEW arranca disabled; no cierra el acceso de nadie).
    if (!(await this.policy.getEnabled('access.ip-allowlist'))) return true;

    // Fail-safe: allowlist VACÍA → ALLOW (nunca dejar afuera al superadmin por una lista sin configurar).
    const cidrs = await this.policy.list('access.ip-allowlist', 'cidrs', []);
    if (cidrs.length === 0) return true;

    // IP REAL del cliente (Express `trust proxy` la resolvió en main.ts descartando hops de confianza).
    const ip = req.ip ?? req.socket?.remoteAddress;
    if (!ip || !ipInAnyCidr(ip, cidrs)) {
      throw new ForbiddenError('Acceso denegado: IP fuera de la lista blanca autorizada', {
        policy: 'access.ip-allowlist',
      });
    }
    return true;
  }
}
