/**
 * Puerto SÍNCRONO de lectura de políticas para guards de bajo nivel (PBAC · ADR-024 §9).
 *
 * Los guards (p.ej. `StepUpMfaGuard`) resuelven su parámetro de política SIN `await`: su `canActivate`
 * es síncrono (contrato NestJS que usan todos los specs). Por eso `@veo/auth` define su PROPIO puerto
 * síncrono + token en vez de importar el `PolicyReader` async de `@veo/policy`, y esto es DELIBERADO:
 *   1. Evita un CICLO de paquetes — `@veo/policy/nest` (cliente runtime) depende de `@veo/auth` (vía
 *      `@veo/rpc`), así que `@veo/auth` NO puede depender de `@veo/policy`.
 *   2. Mantiene `@veo/auth` como leaf: no arrastra la infra de Kafka/rpc del cliente cacheado.
 *
 * El cliente runtime (`KafkaCachedPolicyReader` de `@veo/policy/nest`) IMPLEMENTA este puerto leyendo su
 * cache en memoria (síncrono). Cada servicio que registra `PolicyModule` lo provee bajo `POLICY_READER_PORT`;
 * si NINGÚN servicio lo registra, el guard usa su `fallback` in-situ (mismo fail-safe · ADR §4). El puerto
 * NUNCA abre el candado: ante ausencia de dato, devuelve el `fallback` endurecido (fail-safe, no fail-open).
 */
export interface PolicyReaderPort {
  /**
   * Lee un param NUMÉRICO de una política desde el cache (SÍNCRONO). Devuelve el valor vigente si está,
   * o `fallback` si la política/param no está en cache ni tiene default numérico (nunca fail-open).
   */
  numberSync(key: string, param: string, fallback: number): number;
}

/**
 * Token DI del puerto síncrono de políticas. Se inyecta OPCIONAL en los guards: si no hay provider
 * registrado (servicio sin `PolicyModule`), el guard cae a su default in-situ (fail-safe · ADR §4).
 */
export const POLICY_READER_PORT = Symbol('VEO_POLICY_READER_PORT');
