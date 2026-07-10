/**
 * @veo/policy — CONTRATO PBAC (ADR-024, Fase 0 / Ola 1).
 *
 * EL contrato del que dependen identity-service (storage de la tabla `Policy`), admin-bff (endpoints
 * GET/PUT gobierno/policies) y admin-web (pantalla `Gobierno → Políticas`). Provee:
 *   • tipos: `PolicyKey` (las 16 keys), `PolicyFamily`, `PolicyDef`, `PolicyParams`
 *   • `POLICY_CATALOG` / `POLICY_LIST`: las 16 políticas con schema Zod, defaults, `mandatory`, textos UI
 *   • `PolicyReader`: puerto de solo lectura para inyectar en guards sin acoplarse al cliente runtime
 *   • `DefaultPolicyReader`: impl fail-safe que devuelve los DEFAULTs (base + tests)
 *   • helpers: `getPolicyDef`, `DEFAULT_PARAMS`, `validateParams`, `safeValidateParams`
 *
 * ALCANCE DE ESTA OLA: solo el contrato. El cliente runtime cacheado + suscripción Kafka a
 * `policy.updated` es Fase 1 (implementa la MISMA interfaz `PolicyReader`).
 */
export * from './keys.js';
export * from './catalog.js';
export * from './reader.js';
export * from './overlay.js';
export * from './helpers.js';
export * from './tokens.js';
