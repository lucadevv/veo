/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el BFF no arranca.
 * El public-bff es un agregador sin base de datos propia: valida JWT, propaga identidad interna
 * firmada (HMAC) aguas abajo y habla con los microservicios vía gRPC (lecturas) y REST interno (comandos).
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ── Identidad / JWT (validación ES256 en el gateway; solo se necesita la clave pública) ──
  // En dev, si falta la PEM pública se genera un par efímero (los tokens externos no validarán,
  // pero el servicio arranca). En producción es obligatoria.
  VEO_JWT_PUBLIC_PEM: z.string().optional(),
  VEO_JWT_ISSUER: z.string().default('veo-identity'),
  VEO_JWT_AUDIENCE: z.string().default('veo-app'),

  // Secreto HMAC para firmar la identidad interna que el BFF propaga a los servicios.
  VEO_INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Secreto HMAC COMPARTIDO de la firma del request de pánico (BR-S04). El cliente lo obtiene vía
  // POST /auth/panic-key (JWT) y firma el cuerpo del POST /panic; panic-service lo verifica con el
  // MISMO secreto. Modelo actual: secreto compartido del servicio (no per-user). El default DEBE
  // coincidir con el de panic-service para que dev funcione end-to-end.
  PANIC_HMAC_SECRET: secret('dev-panic-hmac-secret-change-me'),

  // ── Infraestructura ──
  REDIS_URL: z.string().default('redis://localhost:6379'),
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // ── Mapas. Modos: `osrm`/`local` (OSM self-hosted, soberanía §0.7) o `mapbox` (APIs HTTP de
  //    Mapbox con token público `pk`, server-side). Todos degradan al motor local ante fallo. ──
  VEO_MAPS_MODE: z.enum(['osrm', 'local', 'mapbox']).default('osrm'),
  OSRM_URL: z.string().default('http://localhost:5000'),
  NOMINATIM_URL: z.string().default('http://localhost:8080'),
  // Token público de Mapbox (`pk....`). Obligatorio solo cuando VEO_MAPS_MODE=mapbox.
  MAPBOX_ACCESS_TOKEN: z.string().optional(),

  // ── Pricing (ADR 011 M4). Piso de la PUJA que el quote expone en modo PUJA (espeja trip-service). ──
  BID_FLOOR_CENTS: z.coerce.number().int().positive().default(700),

  // ── gRPC downstream (lecturas) ──
  IDENTITY_GRPC_URL: z.string().default('localhost:50051'),
  TRIP_GRPC_URL: z.string().default('localhost:50052'),
  DISPATCH_GRPC_URL: z.string().default('localhost:50053'),
  PAYMENT_GRPC_URL: z.string().default('localhost:50055'),
  PANIC_GRPC_URL: z.string().default('localhost:50056'),
  RATING_GRPC_URL: z.string().default('localhost:50060'),
  SHARE_GRPC_URL: z.string().default('localhost:50061'),
  FLEET_GRPC_URL: z.string().default('localhost:50062'),
  // places-service (Lote B): lugares guardados del pasajero (CRUD gRPC).
  PLACES_GRPC_URL: z.string().default('localhost:50063'),
  GRPC_DEADLINE_MS: z.coerce.number().default(5000),

  // ── REST interno downstream (comandos). baseUrl = http://localhost:300X/api/v1 ──
  IDENTITY_URL: z.string().default('http://localhost:3001/api/v1'),
  TRIP_URL: z.string().default('http://localhost:3002/api/v1'),
  // dispatch-service — comandos REST de la PUJA (listar/aceptar/cancelar ofertas del board).
  DISPATCH_URL: z.string().default('http://localhost:3003/api/v1'),
  PAYMENT_URL: z.string().default('http://localhost:3005/api/v1'),
  PANIC_URL: z.string().default('http://localhost:3006/api/v1'),
  SHARE_URL: z.string().default('http://localhost:3011/api/v1'),
  RATING_URL: z.string().default('http://localhost:3010/api/v1'),
  NOTIFICATION_URL: z.string().default('http://localhost:3008/api/v1'),
  // chat-service (Ola 2A) — historial + persistencia de mensajes; la entrega RT la hace este BFF.
  CHAT_URL: z.string().default('http://localhost:3014/api/v1'),
  // media-service — presign de subida del avatar (PUT directo a MinIO/S3).
  MEDIA_URL: z.string().default('http://localhost:3007/api/v1'),
  REST_TIMEOUT_MS: z.coerce.number().default(8000),

  // ── Rate limiting (Redis). POST /panic JAMÁS se limita (BR / FOUNDATION §14). ──
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),

  // ── LiveKit self-hosted (video del habitáculo, soberanía §0.7). ──
  // Si falta API_KEY/API_SECRET el video queda DESHABILITADO (la web familiar degrada a "sin video").
  // El token de viewer (solo suscripción) se firma HS256 con el secreto; nunca se inventan credenciales.
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  LIVEKIT_GRANT_TTL_SEC: z.coerce.number().default(3600),

  // ── CORS (lista separada por comas; '*' permite cualquiera) ──
  CORS_ORIGINS: z.string().default('*'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
}).superRefine((env, ctx) => {
  // En modo `mapbox` el token público `pk` es obligatorio: sin él no se puede hablar con la API.
  if (env.VEO_MAPS_MODE === 'mapbox' && !env.MAPBOX_ACCESS_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAPBOX_ACCESS_TOKEN'],
      message: 'MAPBOX_ACCESS_TOKEN es obligatorio cuando VEO_MAPS_MODE=mapbox',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Valida y normaliza el entorno de proceso. Lanza si una var requerida falta o es inválida. */
export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
