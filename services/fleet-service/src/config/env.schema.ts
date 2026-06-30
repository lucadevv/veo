/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3012),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks de cron + cache de lecturas calientes)
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto compartido para verificar la identidad interna propagada por el BFF
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // trip-service: base REST interna. fleet la consume para leer el catálogo EFECTIVO del admin
  // (GET /internal/catalog, base ⟕ overlay) en el gate de operabilidad por clase del alta. Llamada
  // SERVICE-TO-SERVICE (sin usuario): se firma con audiencia `service-rail` reusando INTERNAL_IDENTITY_SECRET.
  TRIP_URL: requiredInProd('http://localhost:3002/api/v1'),
  // Timeout de las llamadas REST internas salientes (mismo default que los BFFs). El gate degrada
  // honesto si vence (cae al default estático OPERABLE_VEHICLE_CLASSES), nunca crashea el alta.
  REST_TIMEOUT_MS: z.coerce.number().default(8000),

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
