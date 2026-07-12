/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { BID_MAX_CENTS, requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { MAPS_MODES } from '@veo/maps';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z
  .object({
    // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
    // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
    ...grpcTlsEnvSchema.shape,
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3002),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Base de datos (read/write split)
    DATABASE_URL: z.string().url(),
    DATABASE_URL_REPLICA: z.string().url().optional(),

    // Redis (idempotencia de consumidor + caché de rutas)
    REDIS_URL: requiredInProd('redis://localhost:6379'),

    // Kafka (outbox relay + consumidor dispatch.match_found)
    KAFKA_BROKERS: requiredInProd('localhost:9094'),

    // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
    // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
    // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
    ...outboxEnvSchema.shape,

    // Secreto para validar la identidad interna que el BFF propaga a servicios. También firma la identidad
    // de SISTEMA con la que el cliente de @veo/policy consulta el registro central (GET /internal/policies).
    INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

    // Base del API interno de identity-service (registro central de políticas PBAC · ADR-024 Fase 1). El
    // cliente de @veo/policy hace GET /internal/policies (firmado admin-rail) al boot para poblar su cache;
    // si es inalcanzable, cae al DEFAULT del catálogo (fail-safe, nunca tumba el arranque). Incluye /api/v1.
    IDENTITY_INTERNAL_URL: requiredInProd('http://localhost:3001/api/v1', { url: true }),

    // Puerto de mapas (@veo/maps). 'local' = motor propio determinista; 'osrm' = infra OSM self-hosted;
    // 'mapbox' = Directions API (token pk, detrás del puerto). Enum derivado de MAPS_MODES (sin drift).
    VEO_MAPS_MODE: z.enum(MAPS_MODES).default('local'),
    OSRM_BASE_URL: z.string().default('http://localhost:5000'),
    NOMINATIM_BASE_URL: z.string().default('http://localhost:8080'),
    // Token público de Mapbox (`pk....`). Obligatorio solo cuando VEO_MAPS_MODE=mapbox (ver superRefine).
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // gRPC (lectura síncrona desde otros servicios)
    GRPC_URL: z.string().default('0.0.0.0:50052'),

    // PUJA (ADR 010): el bid del pasajero pasa a ser el fareCents del viaje, validado ≥ piso.
    // Piso del bid en céntimos PEN. Decisión #3: el piso CANÓNICO es Admin·Pricing POR ZONA (motor
    // de tarifas). Mientras ese piso por zona no esté expuesto, degradamos HONESTAMENTE a este piso
    // GLOBAL temporal (S/7 = 700). Migrar a floor(zona) cuando exista (degradación honesta, §7).
    BID_FLOOR_CENTS: z.coerce.number().int().positive().default(700),
    // PUJA (ADR 010): TECHO del bid/contraoferta en céntimos PEN. Guardarraíl anti-abuso/anti-overflow
    // (Trip.fareCents es int4 de Postgres) — una carrera urbana en Lima no puede valer más que esto.
    // Default = BID_MAX_CENTS canónico de @veo/utils (S/ 9,999); ajustable por entorno. Es el chequeo
    // de dominio AUTORITATIVO en createTrip/applyAgreedFare (los DTOs son la primera barrera).
    BID_MAX_CENTS: z.coerce.number().int().positive().default(BID_MAX_CENTS),
    // Ventana de la puja en segundos (decisión #9.1: 60s). ADVISORY desde ADR-019 Lote A: dispatch es la
    // AUTORIDAD de la ventana (config editable por el admin en dispatch_radius_config). trip-service la
    // sigue enviando en bid_posted.windowSec por compat, pero openBoard/reopenBoard mandan el valor vigente.
    BID_WINDOW_SEC: z.coerce.number().int().positive().default(60),
    // PUJA robustez #4: tope de re-asignaciones tras cancelación del conductor post-accept. Superado el
    // tope, el viaje NO se re-puja más (anti bucle infinito): cae a FAILED y se notifica al pasajero.
    TRIP_MAX_REASSIGN: z.coerce.number().int().nonnegative().default(3),

    // Watchdog de estado (sweeper temporal): umbrales de estancamiento por familia de estado.
    // Un viaje REQUESTED sin conductor más de N minutos → EXPIRED (no se consiguió match).
    TRIP_REQUESTED_TIMEOUT_MIN: z.coerce.number().int().positive().default(10),
    // Un viaje PRE-RECOJO ya asignado (ASSIGNED/ACCEPTED/ARRIVING/ARRIVED) sin avanzar más de N
    // minutos → EXPIRED (el conductor no aceptó o nunca llegó al recojo).
    TRIP_PREPICKUP_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
    // Un viaje IN_PROGRESS sin actividad más de N horas → FAILED (viaje abandonado; app caída).
    // Holgura generosa: viajes largos reales no deben dispararlo.
    TRIP_INPROGRESS_STALE_HOURS: z.coerce.number().int().positive().default(6),

    // Lote C1 · Parada mid-trip negociada: TTL (segundos) de una propuesta de parada. Pasado este lapso
    // sin respuesta del conductor, el sweeper la expira (EXPIRED + outbox). Ventana corta porque el viaje
    // está EN CURSO: el conductor debe decidir rápido. Default 30s.
    WAYPOINT_PROPOSAL_TTL_SEC: z.coerce.number().int().positive().default(30),

    // S3 (ADR 011) — TTL (ms) del cache in-proc del schedule de pricing. La fila cambia en el orden de
    // HORAS, así que un cache corto absorbe el read-per-resolve (createTrip + quote). El PUT lo invalida
    // (cambio inmediato), así que el TTL solo acota la staleness ante ediciones desde OTRO proceso. 0 = off.
    PRICING_SCHEDULE_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(10_000),
  })
  .superRefine((env, ctx) => {
    // Mapbox sin token reventaría al construir el cliente (createMapsClient). Falla temprano y claro.
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
