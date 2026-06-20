/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3012),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks de cron + cache de lecturas calientes)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto compartido para verificar la identidad interna propagada por el BFF
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // BR-I04: umbral (días) para marcar EXPIRING_SOON y los hitos de alerta previos al vencimiento.
  EXPIRY_WARNING_DAYS: z.coerce.number().default(30),
  EXPIRY_ALERT_MILESTONES: z.string().default('30,15,7,1'),

  // BR-D04: antigüedad mínima del vehículo e intervalo de inspección técnica (meses).
  VEHICLE_MIN_YEAR: z.coerce.number().default(2017),
  INSPECTION_INTERVAL_MONTHS: z.coerce.number().default(3),

  // LOTE 3 · umbral de similitud (pg_trgm) para linkear un alta a TEXTO LIBRE (OCR) contra un modelo APROBADO
  // del catálogo. Rango [0,1]: 1 = idéntico, 0 = sin parecido. La similitud combinada de marca+modelo debe
  // ser >= este umbral para reusar el modelo curado (evita duplicados "TOYOTA" vs "Toyota Yaris"); por debajo,
  // se encola como PENDING_REVIEW (source=OCR) y el operador lo cura. 0.45 es un default conservador
  // (matchea variantes/typos razonables sin linkear modelos distintos). Ajustable por entorno.
  VEHICLE_MODEL_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),

  // Puerto externo de verificación de antecedentes (fase 4; hoy revisión manual del operador).
  VEO_BACKGROUND_CHECK_MODE: z.enum(['manual', 'live']).default('manual'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios: identity/admin)
  GRPC_URL: z.string().default('0.0.0.0:50062'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}

/** Parsea EXPIRY_ALERT_MILESTONES ("30,15,7,1") a number[] ordenado desc, sin duplicados ni <=0. */
export function parseAlertMilestones(raw: string): number[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ).sort((a, b) => b - a);
}
