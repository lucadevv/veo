/**
 * PolicyStepUpMfaGuard — step-up MFA POLICY-AWARE (PBAC · ADR-024 §5 · Fase 2 NET-NEW `pii.reveal-stepup`).
 *
 * Gemelo del `StepUpMfaGuard` de `@veo/auth`, pero la ventana de frescura la fija una POLÍTICA (no el const
 * `auth.stepup=300`). Global (APP_GUARD) y metadata-driven: es no-op salvo en handlers marcados con
 * `@RequireStepUpMfaForPolicy(key)`. Reusa la MISMA lógica de frescura (`isMfaFresh`) del step-up base.
 *
 * REGLA DE ORO PBAC (nunca fail-open · ADR §4):
 *   • Handler sin la marca → ALLOW (no aplica).
 *   • Entorno NO endurecido (dev/local) → ALLOW: mismo bypass que el `StepUpMfaGuard` base (menos fricción en dev).
 *   • Política `enabled=false` (default NET-NEW) → ALLOW sin step-up: el comportamiento de HOY (solo RBAC).
 *   • enabled → exige `isMfaFresh(mfaVerifiedAt, maxAgeSec)`; si la MFA no es fresca → 403.
 *
 * Lee `enabled` + `maxAgeSec` del `PolicyReader` async (cache Kafka-invalidada): el superadmin ajusta la ventana
 * sin redeploy. Cache frío → DEFAULT del catálogo (disabled → ALLOW): fail-safe extremo a extremo.
 */
import {
  Injectable,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, isHardenedEnv, CLOCK, type Clock } from '@veo/utils';
import { isMfaFresh, type AuthenticatedUser } from '@veo/auth';
import { POLICY_READER, type PolicyReader, type PolicyKey } from '@veo/policy';
import { REQUIRE_MFA_FOR_POLICY_KEY } from './require-step-up-for-policy.decorator';

/** Ventana por default de `pii.reveal-stepup` (segundos) — fail-safe si el param faltara en el registro. */
const REVEAL_STEP_UP_DEFAULT_MAX_AGE_SEC = 600;

@Injectable()
export class PolicyStepUpMfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POLICY_READER) private readonly policy: PolicyReader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policyKey = this.reflector.getAllAndOverride<PolicyKey | undefined>(
      REQUIRE_MFA_FOR_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policyKey) return true; // handler no marcado → no aplica.

    // Mismo bypass que el StepUpMfaGuard base: en dev/local no se exige step-up (el @Roles sigue protegiendo).
    if (!isHardenedEnv()) return true;

    // Fail-safe: política apagada (default NET-NEW) → sin step-up (RBAC de hoy).
    if (!(await this.policy.getEnabled(policyKey))) return true;

    const maxAgeSec = await this.policy.number(
      policyKey,
      'maxAgeSec',
      REVEAL_STEP_UP_DEFAULT_MAX_AGE_SEC,
    );
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!isMfaFresh(req.user?.mfaVerifiedAt, maxAgeSec, this.clock.now())) {
      throw new ForbiddenError(
        'Se requiere verificación MFA reciente (step-up) para revelar datos sensibles',
        { policy: policyKey, maxAgeSec },
      );
    }
    return true;
  }
}
