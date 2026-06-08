/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3009),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split). Schema lógico "audit".
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Kafka — audit-service CONSUME los eventos auditables del resto del dominio.
  KAFKA_BROKERS: z.string().default('localhost:9094'),
  KAFKA_GROUP_ID: z.string().default('audit-service'),
  /// Si arranca con la cadena vacía, consumir desde el principio del log de Kafka.
  KAFKA_FROM_BEGINNING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Secreto para verificar la identidad interna firmada que propaga el BFF (POST /audit síncrono).
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // gRPC (registro/verificación síncrona desde otros servicios).
  GRPC_URL: z.string().default('0.0.0.0:50059'),

  // === Réplica inmutable WORM a S3/MinIO (Object Lock, modo COMPLIANCE) ===
  /// Activa la réplica a S3. En dev apunta a MinIO. Desactivar solo en tests aislados.
  AUDIT_S3_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  AUDIT_S3_ENDPOINT: z.string().default('http://localhost:9002'),
  AUDIT_S3_REGION: z.string().default('us-east-1'),
  AUDIT_S3_BUCKET: z.string().default('veo-audit-log'),
  AUDIT_S3_ACCESS_KEY: z.string().default('veo_dev'),
  AUDIT_S3_SECRET_KEY: z.string().default('veo_dev_secret'),
  AUDIT_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /// Retención WORM en días. Default 7 años (Ley 29733 / requisitos de retención de evidencia).
  AUDIT_S3_RETENTION_DAYS: z.coerce.number().int().positive().default(2557),
  /// Intervalo del relay que replica entradas pendientes a S3 (ms).
  AUDIT_S3_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(1000),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
