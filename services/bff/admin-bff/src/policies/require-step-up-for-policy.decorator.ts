/**
 * `@RequireStepUpMfaForPolicy(key)` — variante POLICY-AWARE del `@RequireStepUpMfa()` de `@veo/auth`.
 *
 * El `@RequireStepUpMfa()` estático usa SIEMPRE la ventana de `auth.stepup` (300s). Algunas acciones exigen su
 * PROPIA ventana, gobernada por otra política (p. ej. `pii.reveal-stepup` = 600s, más laxa por diseño). Este
 * decorator marca el handler con la KEY de política; el `PolicyStepUpMfaGuard` (global) lee su `enabled` +
 * `maxAgeSec` VIGENTES del registro PBAC y aplica el chequeo de frescura con ESA ventana. Si la política está
 * `disabled` (default NET-NEW), no exige step-up (comportamiento RBAC de hoy).
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { PolicyKey } from '@veo/policy';

/** Metadata key que lee el `PolicyStepUpMfaGuard`. */
export const REQUIRE_MFA_FOR_POLICY_KEY = 'veo:requireMfaForPolicy';

/** Exige MFA fresca según la ventana `maxAgeSec` de la política indicada (solo si está `enabled`). */
export const RequireStepUpMfaForPolicy = (policyKey: PolicyKey): CustomDecorator<string> =>
  SetMetadata(REQUIRE_MFA_FOR_POLICY_KEY, policyKey);
