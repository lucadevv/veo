/**
 * Helpers sobre el catálogo de políticas.
 */
import type { PolicyKey } from './keys.js';
import { isPolicyKey } from './keys.js';
import type { PolicyDef, PolicyParams } from './catalog.js';
import { POLICY_CATALOG } from './catalog.js';

/** Devuelve la definición de una política. Lanza si la key es desconocida (contrato: keys tipadas). */
export function getPolicyDef(key: PolicyKey): PolicyDef {
  if (!isPolicyKey(key)) {
    throw new Error(`[@veo/policy] key de política desconocida: "${String(key)}"`);
  }
  return POLICY_CATALOG[key];
}

/** Copia superficial de los `params` por default de una política. */
export function DEFAULT_PARAMS(key: PolicyKey): PolicyParams {
  return { ...getPolicyDef(key).defaults };
}

/**
 * Valida `params` contra el schema Zod de la política. Devuelve los params parseados (tipados por el
 * schema) o LANZA `ZodError` si no cumplen. Fuente única de forma para el CRUD de identity-service y la
 * UI de config (ADR §9, contra la deriva).
 */
export function validateParams(key: PolicyKey, params: unknown): unknown {
  return getPolicyDef(key).paramsSchema.parse(params);
}

/** Variante no-lanzante: `{ success, data }` o `{ success:false, error }` (envelope de Zod safeParse). */
export function safeValidateParams(
  key: PolicyKey,
  params: unknown,
): ReturnType<PolicyDef['paramsSchema']['safeParse']> {
  return getPolicyDef(key).paramsSchema.safeParse(params);
}
