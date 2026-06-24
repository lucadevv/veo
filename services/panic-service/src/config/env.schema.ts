/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3006),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (readiness + rate-limit de endpoints NO críticos; /panic nunca se throttlea)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay → panic.triggered / panic.acknowledged)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto de identidad interna que el BFF propaga a los servicios (HMAC del header).
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Secreto HMAC de la firma del request de pánico (BR-S04). En prod viene de Secrets Manager.
  // El cliente firma el cuerpo del POST /panic; el servicio rechaza firmas inválidas.
  PANIC_HMAC_SECRET: secret('dev-panic-hmac-secret-change-me'),

  // ── Evidencia S3 (Object Lock / WORM). Self-hosted: MinIO en dev. ──
  // 'live' usa el cliente S3 real contra el endpoint; 'sandbox' no toca red (tests/CI offline).
  VEO_EVIDENCE_MODE: z.enum(['live', 'sandbox']).default('live'),
  S3_ENDPOINT: z.string().default('http://localhost:9002'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('veo_dev'),
  // Credencial del storage soberano de EVIDENCIA de pánico (Ley 29733). Fail-fast en prod.
  S3_SECRET_KEY: secret('veo_dev_secret'),
  S3_BUCKET_EVIDENCE: z.string().default('veo-panic-evidence-dev'),
  /// Días de retención WORM (Object Lock) de la evidencia de pánico.
  EVIDENCE_RETENTION_DAYS: z.coerce.number().default(365),
  /// Nº de keys de evidencia reservadas por evento (segmentos de grabación).
  EVIDENCE_KEYS_PER_PANIC: z.coerce.number().default(1),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios: veo.panic.v1)
  GRPC_URL: z.string().default('0.0.0.0:50056'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
