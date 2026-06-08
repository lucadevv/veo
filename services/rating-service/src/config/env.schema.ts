/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3010),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (lock del recálculo del cron, cache de agregados)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumo de trip.completed)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto para verificar la identidad interna que el BFF propaga a servicios
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Ventana del promedio rolling (BR-D01/BR-I05). Días.
  ROLLING_WINDOW_DAYS: z.coerce.number().default(30),
  // Umbrales de flag del conductor (BR-D01).
  DRIVER_REVIEW_THRESHOLD: z.coerce.number().default(4.3),
  DRIVER_SUSPENSION_THRESHOLD: z.coerce.number().default(4.0),
  // Umbral de re-verificación del pasajero (BR-I05).
  PASSENGER_REVERIFY_THRESHOLD: z.coerce.number().default(4.0),
  // Expresión cron del recálculo diario (ventana deslizante). Default 03:10 todos los días.
  RECOMPUTE_CRON: z.string().default('0 10 3 * * *'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona del agregado para scoring de dispatch)
  GRPC_URL: z.string().default('0.0.0.0:50060'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
