/**
 * PolicyReader — puerto de SOLO LECTURA para consumir políticas (ADR-024 §9).
 *
 * Los guards de bajo nivel (`StepUpMfaGuard`, etc.) inyectan esta interfaz, NO el cliente runtime de
 * `@veo/policy` (que en Fase 1 trae cache + suscripción Kafka). Así `packages/auth` no arrastra peso de
 * infra ni corre riesgo de ciclo. Cada servicio provee la impl concreta por DI; si no la registra, el
 * guard usa el `fallback` in-situ (mismo fail-safe).
 */
import type { PolicyKey } from './keys.js';
import { getPolicyDef } from './helpers.js';

/**
 * Puerto de lectura de políticas. Todos los métodos reciben un `fallback` (salvo `getEnabled`/`params`)
 * que se devuelve cuando la política no define ese param — el guard nunca queda sin valor. Fail-safe.
 */
export interface PolicyReader {
  /** ¿La política está habilitada? */
  getEnabled(key: PolicyKey): Promise<boolean>;
  /** Lee un param numérico; `fallback` si no existe o no es número. */
  number(key: PolicyKey, param: string, fallback: number): Promise<number>;
  /** Lee un param booleano; `fallback` si no existe o no es booleano. */
  bool(key: PolicyKey, param: string, fallback: boolean): Promise<boolean>;
  /** Lee un param lista-de-strings; `fallback` si no existe o no es un array de strings. */
  list(key: PolicyKey, param: string, fallback: string[]): Promise<string[]>;
  /** Objeto `params` completo y crudo de la política. */
  params(key: PolicyKey): Promise<unknown>;
}

/** Lee un param del objeto `params` con narrowing por tipo. */
function readParam(key: PolicyKey, param: string): unknown {
  return getPolicyDef(key).defaults[param];
}

/**
 * Impl fail-safe base: SIEMPRE devuelve los DEFAULTs del catálogo (ADR §4).
 *
 * Es el comportamiento seguro de hoy, y sirve a tests y a servicios que aún no wirean el cliente real
 * (Fase 1). No hace I/O ni cache — es puro sobre `POLICY_CATALOG`. En Fase 1, el cliente Kafka-cacheado
 * de `@veo/policy` implementa esta MISMA interfaz leyendo la tabla `Policy`, con este default de fallback.
 */
export class DefaultPolicyReader implements PolicyReader {
  async getEnabled(key: PolicyKey): Promise<boolean> {
    return getPolicyDef(key).defaultEnabled;
  }

  async number(key: PolicyKey, param: string, fallback: number): Promise<number> {
    const value = readParam(key, param);
    return typeof value === 'number' ? value : fallback;
  }

  async bool(key: PolicyKey, param: string, fallback: boolean): Promise<boolean> {
    const value = readParam(key, param);
    return typeof value === 'boolean' ? value : fallback;
  }

  async list(key: PolicyKey, param: string, fallback: string[]): Promise<string[]> {
    const value = readParam(key, param);
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value as string[];
    }
    return fallback;
  }

  async params(key: PolicyKey): Promise<unknown> {
    return getPolicyDef(key).defaults;
  }
}
