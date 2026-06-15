/**
 * Validación de entorno del driver-bff (FOUNDATION §4). Si falta una var requerida,
 * el proceso no arranca. Sin valores hardcodeados: defaults solo para desarrollo local.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';
import { MAPS_MODES } from '@veo/maps';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4002),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // CORS: lista separada por comas; '*' permite cualquier origen (solo dev).
  CORS_ORIGINS: z.string().default('*'),

  // JWT ES256 — el BFF SOLO verifica (clave pública). La privada vive en identity-service.
  // En dev, si falta la pública, se genera un par efímero (no sirve para verificar tokens reales).
  VEO_JWT_PUBLIC_PEM: z.string().optional(),
  VEO_JWT_ISSUER: z.string().default('veo-identity'),
  VEO_JWT_AUDIENCE: z.string().default('veo-app'),

  // Secreto HMAC para firmar la identidad interna que se propaga aguas abajo.
  // Debe coincidir con el de los microservicios (InternalIdentityGuard).
  VEO_INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Redis (rate limiting por IP+usuario+ruta).
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (consumidor de eventos para empujar a la app del conductor por Socket.IO).
  KAFKA_BROKERS: z.string().default('localhost:9094'),
  KAFKA_GROUP_ID: z.string().default('driver-bff'),

  // ── Mapas (Ola 2C · navegación turn-by-turn). osrm/local self-hosted; 'mapbox' = Directions API
  // (token pk, detrás del puerto), con fallback al motor local. Enum derivado de MAPS_MODES (sin drift). ──
  VEO_MAPS_MODE: z.enum(MAPS_MODES).default('osrm'),
  OSRM_URL: z.string().default('http://localhost:5000'),
  NOMINATIM_URL: z.string().default('http://localhost:8080'),
  // Token público de Mapbox (`pk....`). Obligatorio solo cuando VEO_MAPS_MODE=mapbox (ver superRefine).
  MAPBOX_ACCESS_TOKEN: z.string().optional(),

  // gRPC (LECTURAS): host:port de cada microservicio.
  IDENTITY_GRPC_URL: z.string().default('localhost:50051'),
  TRIP_GRPC_URL: z.string().default('localhost:50052'),
  DISPATCH_GRPC_URL: z.string().default('localhost:50053'),
  PAYMENT_GRPC_URL: z.string().default('localhost:50055'),
  RATING_GRPC_URL: z.string().default('localhost:50060'),
  FLEET_GRPC_URL: z.string().default('localhost:50062'),

  // REST interno (COMANDOS): base http de cada microservicio (sin /api/v1, se añade en el cliente).
  IDENTITY_URL: z.string().url().default('http://localhost:3091'),
  TRIP_URL: z.string().url().default('http://localhost:3092'),
  DISPATCH_URL: z.string().url().default('http://localhost:3093'),
  PAYMENT_URL: z.string().url().default('http://localhost:3005'),
  PAYOUTS_URL: z.string().url().default('http://localhost:3005'),
  NOTIFICATION_URL: z.string().url().default('http://localhost:3008'),
  FLEET_URL: z.string().url().default('http://localhost:3012'),
  MEDIA_URL: z.string().url().default('http://localhost:3007'),
  // chat-service (Ola 2A): historial + persistencia de mensajes del viaje.
  CHAT_URL: z.string().url().default('http://localhost:3014'),

  // Rate limiting (ventana fija por IP+usuario+ruta).
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  // Timeout de las llamadas REST internas (ms).
  DOWNSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
}).superRefine((env, ctx) => {
  // Mapbox sin token reventaría al construir el cliente. Falla temprano y claro.
  if (env.VEO_MAPS_MODE === 'mapbox' && !env.MAPBOX_ACCESS_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAPBOX_ACCESS_TOKEN'],
      message: 'MAPBOX_ACCESS_TOKEN es obligatorio cuando VEO_MAPS_MODE=mapbox',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
