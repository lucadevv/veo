/**
 * `@veo/policy/nest` — SUB-EXPORT runtime del cliente de políticas (ADR-024 Fase 1).
 *
 * SEPARADO a propósito del barrel liviano (`@veo/policy`): solo los servicios NestJS de enforcement importan
 * este entry (`import { PolicyModule, KafkaCachedPolicyReader } from '@veo/policy/nest'`). Arrastra Kafka
 * (`@veo/events/nest`) + REST interno (`@veo/rpc`) + Nest; el barrel liviano queda con solo zod (tipos +
 * catálogo + interfaz `PolicyReader` + tokens), para que `@veo/auth` y quien solo use el contrato no cargue
 * la infra. (`@veo/auth` de hecho NO importa `@veo/policy`: el guard usa su propio `POLICY_READER_PORT`.)
 */
export * from './nest/registry.js';
export * from './nest/kafka-cached-policy-reader.js';
export * from './nest/policy-updated.consumer.js';
export * from './nest/permission-override-updated.consumer.js';
export * from './nest/policy.module.js';
