/**
 * StepUpMfaGuard — exige verificación MFA fresca (TOTP) para acciones marcadas con @RequireStepUpMfa
 * (acceso a video, gestión RBAC, payouts > S/5K — BR-S07).
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, isHardenedEnv } from '@veo/utils';
import { REQUIRE_MFA_KEY } from '../decorators.js';
import { isMfaFresh } from '../totp.js';
import type { AuthenticatedUser } from '../jwt.js';

@Injectable()
export class StepUpMfaGuard implements CanActivate {
  /** Antigüedad máxima de la verificación MFA en segundos. */
  private readonly maxAgeSec = 300;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    // DEV: el step-up MFA estorba al desarrollo (el superadmin opera sin re-tipear TOTP). Solo los
    // entornos internet-facing (NODE_ENV=production → preview Y prod) exigen la doble-auth fresca; en
    // local/dev se omite. El gate de ROL (@Roles) sigue protegiendo en TODOS los entornos.
    if (!isHardenedEnv()) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!isMfaFresh(req.user?.mfaVerifiedAt, this.maxAgeSec)) {
      throw new ForbiddenError('Se requiere verificación MFA reciente (step-up)', {
        maxAgeSec: this.maxAgeSec,
      });
    }
    return true;
  }
}
