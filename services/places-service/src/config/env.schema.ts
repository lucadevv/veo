/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3013),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split). El schema lógico se aísla con ?schema=places en la URL.
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (readiness + rate-limit; compartido con el dev-stack)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ── Reglas de negocio (server-side) ──
  /// Tope de favoritos por usuario (Casa/Trabajo no cuentan). Espeja MAX_FAVORITES de la app.
  MAX_FAVORITES: z.coerce.number().int().min(1).default(20),
  /// Longitud máxima de la etiqueta (espeja MAX_PLACE_LABEL_LENGTH de la app).
  MAX_PLACE_LABEL_LENGTH: z.coerce.number().int().min(1).default(40),

  // Secreto de identidad interna que el BFF propaga a los servicios (HMAC)
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (CRUD síncrono consumido por el public-bff)
  GRPC_URL: z.string().default('0.0.0.0:50063'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
