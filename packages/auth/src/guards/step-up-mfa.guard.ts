/**
 * StepUpMfaGuard — exige verificación MFA fresca (TOTP) para acciones marcadas con @RequireStepUpMfa
 * (acceso a video, gestión RBAC, payouts > S/5K — BR-S07).
 */
import {
  Injectable,
  Inject,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, isHardenedEnv, CLOCK, type Clock } from '@veo/utils';
import { REQUIRE_MFA_KEY } from '../decorators.js';
import { isMfaFresh } from '../totp.js';
import { POLICY_READER_PORT, type PolicyReaderPort } from '../policy-port.js';
import type { AuthenticatedUser } from '../jwt.js';

/**
 * Ventana por default de la política `auth.stepup` (segundos). Es el DEFAULT fail-safe si no hay reader.
 * EXPORTADO (fuente única): los servicios que re-chequean frescura MFA en capa de servicio (ej.
 * PayoutsService.hasFreshMfa) importan ESTE valor como fallback — nunca duplicar el literal 300.
 */
export const STEP_UP_DEFAULT_MAX_AGE_SEC = 300;

@Injectable()
export class StepUpMfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
    // PBAC (ADR-024 §9): puerto de políticas OPCIONAL. Si un servicio registra `PolicyModule`, el guard
    // lee la ventana `auth.stepup.maxAgeSec` VIGENTE del cache (cambio del superadmin surte efecto sin
    // redeploy). Si NADIE lo provee, cae al default endurecido (mismo fail-safe de siempre). NO se acopla
    // al cliente concreto: inyecta la interfaz síncrona, no `KafkaCachedPolicyReader`.
    @Optional() @Inject(POLICY_READER_PORT) private readonly policy?: PolicyReaderPort,
  ) {}

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

    // Ventana vigente de la política (cache PBAC) o el default endurecido si no hay reader registrado.
    const maxAgeSec =
      this.policy?.numberSync('auth.stepup', 'maxAgeSec', STEP_UP_DEFAULT_MAX_AGE_SEC) ??
      STEP_UP_DEFAULT_MAX_AGE_SEC;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!isMfaFresh(req.user?.mfaVerifiedAt, maxAgeSec, this.clock.now())) {
      throw new ForbiddenError('Se requiere verificación MFA reciente (step-up)', {
        maxAgeSec,
      });
    }
    return true;
  }
}
