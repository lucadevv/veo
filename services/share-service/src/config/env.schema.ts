/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3011),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (OTP de contactos + cool-down de la lista + rate-limit)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores)
  KAFKA_BROKERS: z.string().default('localhost:9094'),
  KAFKA_CONSUMER_GROUP: z.string().default('share-service'),

  // Secreto para firmar los enlaces de seguimiento (HMAC). KMS/Secrets Manager en prod.
  SHARE_LINK_SECRET: z.string().default('dev-share-link-secret-change-me'),
  // TTL del enlace de seguimiento (por defecto 2h tras crearlo, configurable).
  SHARE_LINK_TTL_SECONDS: z.coerce.number().default(7_200),
  // Usos máximos por defecto de un enlace (la página familia se refresca varias veces).
  SHARE_LINK_MAX_USES: z.coerce.number().default(500),
  // Base pública para construir la URL del enlace que se envía por SMS.
  SHARE_PUBLIC_BASE_URL: z.string().default('http://localhost:3011/api/v1/public/share'),

  // Contactos de confianza (BR-I06)
  MAX_TRUSTED_CONTACTS: z.coerce.number().default(3),
  // Cool-down para modificar la lista de contactos (24h por defecto).
  CONTACT_MODIFY_COOLDOWN_HOURS: z.coerce.number().default(24),

  // OTP de verificación del contacto
  OTP_TTL_SECONDS: z.coerce.number().default(300), // 5 min
  OTP_MAX_ATTEMPTS: z.coerce.number().default(3),

  // Puerto SMS (modo propio/sandbox por defecto)
  VEO_SMS_MODE: z.enum(['live', 'sandbox']).default('sandbox'),

  // Secreto de identidad interna que el BFF propaga a los servicios
  INTERNAL_IDENTITY_SECRET: z.string().default('dev-internal-secret-change-me'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios: notification/panic)
  GRPC_URL: z.string().default('0.0.0.0:50061'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
