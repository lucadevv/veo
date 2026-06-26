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
  PORT: z.coerce.number().default(3010),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (lock del recálculo del cron, cache de agregados)
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay + consumo de trip.completed)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto para verificar la identidad interna que el BFF propaga a servicios
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Ventana del promedio rolling (BR-D01/BR-I05). Días.
  ROLLING_WINDOW_DAYS: z.coerce.number().default(30),
  // Umbrales de flag del conductor (BR-D01).
  DRIVER_REVIEW_THRESHOLD: z.coerce.number().default(4.3),
  DRIVER_SUSPENSION_THRESHOLD: z.coerce.number().default(4.0),
  // Mínimo de reseñas para que el flag de conductor ESCALE a 'suspension' (auto-suspensión por rating bajo,
  // decisión del dueño · compliance/seguridad). Por debajo de este mínimo, un promedio < 4.0 SOLO produce
  // 'review' (flag de panel, NO suspende): no se castiga a un conductor por 1-2 reseñas malas tempranas.
  // Entero POSITIVO. Default 10.
  MIN_REVIEWS_FOR_SUSPENSION: z.coerce.number().int().positive().default(10),
  // Umbral de re-verificación del pasajero (BR-I05).
  PASSENGER_REVERIFY_THRESHOLD: z.coerce.number().default(4.0),
  // Expresión cron del recálculo diario (ventana deslizante). Default 03:10 todos los días.
  RECOMPUTE_CRON: z.string().default('0 10 3 * * *'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona del agregado para scoring de dispatch)
  GRPC_URL: z.string().default('0.0.0.0:50060'),
  // gRPC CLIENT a trip-service: valida el viaje en el submit de una calificación (existe + COMPLETED +
  // el rater participó). Gate fail-closed de RatingsService.create. Default = dev-stack.
  TRIP_GRPC_URL: requiredInProd('localhost:50052'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
