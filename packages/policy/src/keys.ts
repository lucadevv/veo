/**
 * Claves y familias de las políticas PBAC (ADR-024 §5).
 *
 * Las 16 keys son la fuente única del catálogo `Gobierno → Políticas` del admin. El orden refleja el
 * de la tabla del ADR. `PolicyKey` se deriva del array para que agregar/quitar una key sea un solo edit.
 */

/**
 * Familia funcional de una política (ADR-024 §5, columna «Familia»).
 * - `auth`   → cómo se autentica/re-autentica un operador (MFA, step-up, timeouts).
 * - `data`   → tratamiento del dato sensible (PII, media, retención, borrado — Ley 29733).
 * - `access` → alcance y condiciones del acceso (JIT, IP allowlist, recertificación, mínimo privilegio).
 * - `ops`    → operaciones de datos en volumen (export, share, bulk-download).
 */
export type PolicyFamily = 'auth' | 'data' | 'access' | 'ops';

/** Las 16 keys canónicas (ADR-024 §5). Orden = orden de la tabla del ADR. */
export const POLICY_KEYS = [
  'media.dual-auth',
  'pii.mask',
  'pii.reveal-stepup',
  'media.retention',
  'privacy.erasure',
  'auth.mfa',
  'auth.stepup',
  'auth.session-timeout',
  'auth.daily-reauth',
  'access.jit',
  'access.ip-allowlist',
  'access.review',
  'access.least-privilege',
  'ops.export',
  'ops.third-party-share',
  'ops.bulk-download',
] as const;

/** Unión literal de las 16 keys. */
export type PolicyKey = (typeof POLICY_KEYS)[number];

/** Set para validación O(1) de una key desconocida (entrada externa, params jsonb, etc.). */
export const POLICY_KEY_SET: ReadonlySet<string> = new Set(POLICY_KEYS);

/** Type-guard: ¿`value` es una `PolicyKey` conocida? */
export function isPolicyKey(value: string): value is PolicyKey {
  return POLICY_KEY_SET.has(value);
}
