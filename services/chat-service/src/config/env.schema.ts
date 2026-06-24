/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { requiredInProd, secret } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3014),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (readiness)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay → chat.message_sent; los BFFs lo consumen para la entrega RT)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),
  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto para verificar la identidad interna propagada por el BFF (HMAC)
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // ── Dominio de chat ──
  /// Longitud máxima del cuerpo de un mensaje.
  CHAT_MAX_BODY_LENGTH: z.coerce.number().int().min(1).default(2000),
  /// Tamaño máximo de página del historial.
  CHAT_MAX_PAGE_SIZE: z.coerce.number().int().min(1).default(100),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
