/**
 * Tokens DI del contrato PBAC (parte LIVIANA de `@veo/policy` — sin runtime de Kafka/rpc).
 *
 * `POLICY_READER` es el token del `PolicyReader` (async, contrato rico de `reader.ts`) que inyectan los
 * SERVICIOS y sweepers (media.retention, media.dual-auth, erasure SLA…). El cliente runtime que lo satisface
 * (`KafkaCachedPolicyReader`) vive en el subpath `@veo/policy/nest`; `PolicyModule` liga este token a esa impl.
 * Vive en la parte liviana para que quien inyecta el contrato NO arrastre la infra (la infra está en el nest).
 *
 * El guard-facing token es OTRO (`POLICY_READER_PORT`, en `@veo/auth`, síncrono) — ver `@veo/auth/policy-port`:
 * el guard no puede depender de `@veo/policy` (ciclo) y necesita una lectura síncrona.
 */
export const POLICY_READER = Symbol('VEO_POLICY_READER');
