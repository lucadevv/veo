/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { BID_MAX_CENTS, secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3003),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (hot index de ubicación + exclusión de pánico + contadores de demanda surge)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto para verificar la identidad interna firmada que el BFF propaga a servicios.
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // gRPC (lectura síncrona desde otros servicios: trip-service consulta el match).
  GRPC_URL: z.string().default('0.0.0.0:50053'),
  // gRPC CLIENT a identity-service: re-valida la elegibilidad del conductor en el submit de la PUJA
  // (ADR 010 §6, cierre estructural del catastrófico #9). Default = dev-stack.
  IDENTITY_GRPC_URL: z.string().default('localhost:50051'),
  // gRPC CLIENT a fleet-service: resuelve el vehículo activo del conductor al ACEPTAR (awarding) para
  // adjuntar vehicleId al match → el viaje queda con su vehículo (trazabilidad). Default = dev-stack.
  FLEET_GRPC_URL: z.string().default('localhost:50062'),

  // OpenTelemetry
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // ── Mapas self-hosted (NO Google). ETA para el scoring (BR-T06). ──
  VEO_MAPS_MODE: z.enum(['osrm', 'local']).default('local'),
  OSRM_BASE_URL: z.string().default('http://localhost:5000'),
  NOMINATIM_BASE_URL: z.string().default('http://localhost:8080'),
  MAPS_CACHE_TTL_SECONDS: z.coerce.number().default(60),

  // ── Hot index ──
  /// TTL del registro de ubicación de un conductor; si no pinguea, deja de ser candidato (BR-T06).
  DRIVER_LOC_TTL_SECONDS: z.coerce.number().default(60),

  // ── Algoritmo de matching (BR-T06) ──
  /// Milisegundos de espera de respuesta del conductor por oferta antes de marcarla TIMEOUT y avanzar.
  DISPATCH_OFFER_TIMEOUT_MS: z.coerce.number().default(12_000),
  /// Radio máximo del k-ring al expandir la búsqueda. El advance agota cada anillo antes de expandir.
  DISPATCH_MAX_K_RING: z.coerce.number().default(2),

  // PUJA (ADR 010 §6, A4): TTL (ms) del cache in-proc de elegibilidad del conductor. El gate hace un
  // gRPC a identity por CADA submit/listOpenBidsNear; un conductor que pollea /bids/open cada 2-3s pega
  // a identity en cada poll por un estado (AVAILABLE/suspendedAt) que cambia en el orden de minutos. Un
  // TTL corto (default 3s) absorbe el poll read-heavy SIN arriesgar frescura en el match: el path de
  // ACCEPT (la decisión de plata) BYPASEA el cache y lee fresco. Solo se cachean lecturas EXITOSAS.
  ELIGIBILITY_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(3_000),

  // PUJA (ADR 010): TECHO de un COUNTER del conductor en céntimos PEN. Una contraoferta tampoco puede
  // superar el guardarraíl (el COUNTER pasa a ser el fareCents si el pasajero la acepta). Default =
  // BID_MAX_CENTS canónico de @veo/utils (S/ 9,999); ajustable por entorno. Es el chequeo de dominio
  // en submitOffer (el DTO es la primera barrera).
  BID_MAX_CENTS: z.coerce.number().int().positive().default(BID_MAX_CENTS),

  // ── Pesos del scoring (BR-T06). Configurables; defaults razonables para Lima. ──
  /// score = w_dist*(1/distM) + w_rating*avgRating + w_idle*(1/segDesdeUltimoViaje) - w_cancel*cancelRate
  DISPATCH_W_DISTANCE: z.coerce.number().default(5000),
  DISPATCH_W_RATING: z.coerce.number().default(1),
  DISPATCH_W_IDLE: z.coerce.number().default(10),
  DISPATCH_W_CANCEL: z.coerce.number().default(5),

  // ── Surge ──
  /// Ventana (s) para contar demanda (trip.requested) por zona en Redis.
  SURGE_DEMAND_WINDOW_SECONDS: z.coerce.number().default(300),

  // ── Mapa de calor de demanda (Ola 2C) ──
  /// Ventana DESLIZANTE (s) de intensidad por celda H3; cada solicitud refresca el TTL de la celda.
  HEATMAP_WINDOW_SECONDS: z.coerce.number().default(900),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
