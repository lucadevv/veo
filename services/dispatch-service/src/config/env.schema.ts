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
    PORT: z.coerce.number().default(3003),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Base de datos (read/write split)
    DATABASE_URL: z.string().url(),
    DATABASE_URL_REPLICA: z.string().url().optional(),

    // Redis (hot index de ubicación + exclusión de pánico + contadores de demanda surge)
    REDIS_URL: requiredInProd('redis://localhost:6379'),

    // Kafka (outbox relay + consumidores)
    KAFKA_BROKERS: requiredInProd('localhost:9094'),

    // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
    // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
    // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
    ...outboxEnvSchema.shape,

    // Secreto para verificar la identidad interna firmada que el BFF propaga a servicios.
    INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

    // gRPC (lectura síncrona desde otros servicios: trip-service consulta el match).
    GRPC_URL: z.string().default('0.0.0.0:50053'),
    // gRPC CLIENT a identity-service: re-valida la elegibilidad del conductor en el submit de la PUJA
    // (ADR 010 §6, cierre estructural del catastrófico #9). Default = dev-stack.
    IDENTITY_GRPC_URL: requiredInProd('localhost:50051'),
    // gRPC CLIENT a fleet-service: resuelve el vehículo activo del conductor al ACEPTAR (awarding) para
    // adjuntar vehicleId al match → el viaje queda con su vehículo (trazabilidad). Default = dev-stack.
    FLEET_GRPC_URL: requiredInProd('localhost:50062'),

    // OpenTelemetry
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // ── Mapas (NO Google). ETA para el scoring (BR-T06). osrm/local self-hosted; 'mapbox' = Matrix API
    // (token pk, detrás del puerto). Enum derivado de MAPS_MODES (fuente única, sin drift). ──
    VEO_MAPS_MODE: z.enum(MAPS_MODES).default('local'),
    OSRM_BASE_URL: z.string().default('http://localhost:5000'),
    NOMINATIM_BASE_URL: z.string().default('http://localhost:8080'),
    MAPS_CACHE_TTL_SECONDS: z.coerce.number().default(60),
    // Token público de Mapbox (`pk....`). Obligatorio solo cuando VEO_MAPS_MODE=mapbox (ver superRefine).
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    // ── Hot index ──
    /// TTL del registro de ubicación de un conductor; si no pinguea, deja de ser candidato (BR-T06).
    DRIVER_LOC_TTL_SECONDS: z.coerce.number().default(60),

    // ── Algoritmo de matching (BR-T06) ──
    /// Milisegundos de espera de respuesta del conductor por oferta antes de marcarla TIMEOUT y avanzar.
    DISPATCH_OFFER_TIMEOUT_MS: z.coerce.number().default(12_000),
    /// Radio máximo del k-ring al expandir la búsqueda. El advance agota cada anillo antes de expandir.
    DISPATCH_MAX_K_RING: z.coerce.number().default(2),
    /// PRESUPUESTO de avance por tick del sweep durable (sweepExpiredOffers). El barrido es SECUENCIAL
    /// (no paraleliza offerNext: el pool es read-only al ofertar y el conductor sale recién en markBusy al
    /// ACEPTAR → paralelizar entre tripIds distintos podría double-offerear al mismo conductor). Sin tope,
    /// un tick podía marcar+avanzar hasta 100 ofertas vencidas, encadenando 100 ciclos de matching en un
    /// cron de 2s. K acota cuántas ofertas vencidas se reclaman+avanzan por tick (las no tomadas siguen
    /// OFFERED y las toma el próximo tick). Marcado (CAS) y avance van ACOPLADOS por fila → sin huérfanas.
    DISPATCH_SWEEP_ADVANCE_BUDGET: z.coerce.number().int().positive().default(25),
    /// DEADLINE (ms) por tick del sweep: backstop ante un offerNext patológicamente lento. Si el tick supera
    /// este presupuesto temporal, corta el for ANTES de marcar la próxima fila (marcado y avance van juntos
    /// por fila, así un corte por deadline NO deja huérfanas). Debe ser < 2000 (el @Interval del reconciler).
    DISPATCH_SWEEP_DEADLINE_MS: z.coerce.number().int().positive().max(1_999).default(1_500),

    // Config de RADIOS (k-rings) editable en runtime por el admin: TTL (ms) del cache in-proc de UN slot
    // que sirve los k-rings al hot-path (feed de mapa + broadcast de pujas). La config cambia en el orden
    // de HORAS; el PUT invalida el cache, así un cambio se ve de inmediato sin esperar el TTL. Default 10s.
    DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(10_000),

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

    // ── Auto-suspensión por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad) ──
    /// Ventana ROLLING (horas) sobre la que se cuentan las cancelaciones POR conductor. Las cancelaciones
    /// más viejas que esto se podan y no cuentan. Default 24h. (Tabla `driver_cancellation_events`, SEPARADA
    /// del contador lifelong del scoring.)
    CANCELLATION_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
    /// Nº de cancelaciones en la ventana que DISPARA la auto-suspensión. Al cruzar exactamente este umbral
    /// (count pasa de THRESHOLD-1 → THRESHOLD) dispatch emite `driver.excessive_cancellations` UNA vez. Default 5.
    CANCELLATION_THRESHOLD: z.coerce.number().int().positive().default(5),

    // ── Exclusión por SUSPENSIÓN del pool de matching (RedisTtlExclusionRegistry) ──
    /// TTL (s) de AUTO-CURA de la exclusión por suspensión. La exclusión es una OPTIMIZACIÓN (no ofertarle
    /// al suspendido); la AUTORIDAD de seguridad es el accept-gate fail-closed. El TTL acota la ventana de
    /// OVER-exclusion: si la señal de reactivación nunca llega (p.ej. la vía fleet-auto doc/ITV NO emite
    /// `driver.reactivated`), la exclusión EXPIRA y el conductor re-entra al pool en vez de quedar pegado
    /// para siempre. Re-suspender refresca el TTL. Default 1h (corto = auto-cura rápida del lado peligroso;
    /// el caso normal limpia al instante por evento). Subir cuando Lote 2b consuma los eventos fleet.
    SUSPENSION_EXCLUSION_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
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
