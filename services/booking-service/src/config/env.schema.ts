/**
 * Validación de entorno del booking-service (FOUNDATION §4 · fail-fast al boot). Si falta una var
 * requerida, el servicio NO arranca. Mismo patrón que identity-service.
 *
 * Puertos fijos del servicio (ADR-014 §12): REST 3016, gRPC 50054.
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { MAPS_MODES } from '@veo/maps';
import { outboxEnvSchema } from '@veo/database';

// ── SOBERANÍA DE ROUTING (FOUNDATION §0.7, regla maestra) ────────────────────────────────────────
// El routing respalda el tope LEGAL de cost-sharing (F1b): es DATO sensible (coordenadas reales del
// viaje) y por tanto SOBERANO — motor propio self-hosted (OSM: OSRM/Valhalla en prod, motor local
// determinista en dev/CI). Mapbox (SaaS de tercero) queda EXCLUIDO A PROPÓSITO: mandar las coordenadas
// del viaje a un tercero viola soberanía + privacidad (Ley 29733). Aunque `@veo/maps.MAPS_MODES` aún
// expone 'mapbox' (drift de contrato del paquete, ver follow-up de soberanía transversal), booking-service
// FILTRA ese modo acá para que NUNCA pueda seleccionarlo, ni siquiera por env mal configurado.
type SovereignMapsMode = Exclude<(typeof MAPS_MODES)[number], 'mapbox'>;
const SOVEREIGN_MAPS_MODES = MAPS_MODES.filter(
  (m): m is SovereignMapsMode => m !== 'mapbox',
) as [SovereignMapsMode, ...SovereignMapsMode[]];

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3016),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split). Schema lógico propio "booking" (DB-per-service).
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (reservado para gates/locks de fases futuras; el lock de asientos del §6 es F3).
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay → topic 'booking').
  KAFKA_BROKERS: requiredInProd('localhost:9094'),
  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto de identidad interna que el BFF propaga a servicios (InternalIdentityGuard). DEBE ser
  // IDÉNTICO en todos los services y BFFs; si difiere, el guard interno rechaza la request.
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios; expone booking.GetPublishedTrip/GetBooking — F2+).
  GRPC_URL: z.string().default('0.0.0.0:50054'),

  // ── Puertos gRPC SALIENTES (consumo síncrono) ──
  // identity.GetDriver (gate F1a: status/suspensión/KYC/antecedentes del conductor antes de publicar).
  IDENTITY_GRPC_URL: requiredInProd('localhost:50051'),
  // fleet.GetDriverVehicles (gate F1a anti-IDOR: pertenencia + vigencia del vehículo al publicar).
  // Default verificado contra dispatch-service / BFFs (fleet gRPC = localhost:50062).
  FLEET_GRPC_URL: requiredInProd('localhost:50062'),
  // payment.GetPayment (leer estado/recibo del cobro ya disparado — gRPC, §5.4). El gate de deuda y el
  // charge NO son gRPC (ver PAYMENT_INTERNAL_URL abajo).
  // Default coherente con el puerto gRPC REAL de payment-service (env.schema → GRPC_URL :50055), NO :50052
  // (ese es trip-service): apuntar a 50052 hacía que booking llamara a trip-service creyendo hablar con
  // payment. Mismo patrón de default-coherente que IDENTITY_GRPC_URL/FLEET_GRPC_URL (apuntan al puerto real).
  PAYMENT_GRPC_URL: requiredInProd('localhost:50055'),
  // ── Borde REST de payment (ADR-014 §5.5) ──
  // El CHARGE (POST /charge · firmado service-rail · F3b) y el gate de DEUDA al reservar (GET /debt · F3a)
  // son REST, no gRPC (corrección as-built del contrato real de payment). Apunta a la API interna de
  // payment-service (/api/v1). Mismo patrón que share-service→notification (NOTIFICATION_INTERNAL_URL).
  // payment-service corre en el puerto 3005. Fail-fast: si falta/inválida, booking NO arranca.
  PAYMENT_INTERNAL_URL: requiredInProd('http://localhost:3005/api/v1', { url: true }),

  // ── BÚSQUEDA GEO H3 (F2 · §6.2) ─────────────────────────────────────────────────────────────────
  // k del anillo H3 de búsqueda (neighbors(celda, k)). k=1 → 7 celdas (≈ la celda + su corona), buen
  // balance urbano Lima (res 9 ≈ 174m). Si la búsqueda con k=1 da CERO resultados, el service EXPANDE a
  // SEARCH_H3_K_RING_EXPAND (k=2 → 19 celdas) una vez. TUNABLES por env sin redeploy. Subir k agranda el
  // radio (más resultados, menos precisión de "cerca"); bajarlo lo achica. Defaults conservadores.
  SEARCH_H3_K_RING: z.coerce.number().int().min(0).max(5).default(1),
  SEARCH_H3_K_RING_EXPAND: z.coerce.number().int().min(0).max(8).default(2),

  // ── @veo/maps (F1b · tope de cost-sharing por distancia) · ROUTING SOBERANO (§0.7) ────────────
  // El tope legal anti-lucro se calcula sobre la DISTANCIA real de la ruta (km) × costo/km. La distancia
  // sale SÓLO de @veo/maps (paquete workspace, soberanía OSM self-hosted §0.7 — NUNCA un tercero SaaS),
  // detrás de un puerto propio (MapsModule), idéntico patrón a trip-service/dispatch-service.
  // 'local' = motor determinista propio (dev/CI sin red, default). 'osrm' = infra OSM self-hosted (prod).
  // Enum = SOVEREIGN_MAPS_MODES (MAPS_MODES SIN 'mapbox'): mapbox queda EXCLUIDO a propósito porque
  // mandaría las coordenadas del viaje a un tercero (violación de soberanía + privacidad Ley 29733).
  VEO_MAPS_MODE: z.enum(SOVEREIGN_MAPS_MODES).default('local'),
  OSRM_BASE_URL: z.string().default('http://localhost:5000'),
  NOMINATIM_BASE_URL: z.string().default('http://localhost:8080'),
  // Timeout por request al motor de rutas (ms). Gate de publicación FAIL-CLOSED: si OSRM no responde en
  // este tiempo, no se publica (mejor bloquear que publicar sin validar el tope legal).
  MAPS_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // ── Costo de operación por km, por país — FALLBACK (F2.5 · ESCUDO LEGAL anti-lucro, ADR-014 §8) ──────
  // La FUENTE AUTORITATIVA del costo/km es la config editable por el admin (CostPerKmConfig en DB, per-país,
  // sembrada PE=150/EC=50). Estos env son SOLO el FALLBACK de degradación honesta: si la config no está
  // disponible (DB sin migrar / país sin sembrar / error transitorio), el tope de cost-sharing cae acá en vez
  // de romper el publish. PE=150 (S/1.50/km, costo real = combustible + desgaste, alineado con la semilla);
  // EC=50 (placeholder, F8). El peaje viaja aparte (lo declara el conductor por viaje, lo suma el cost-cap).
  COST_PER_KM_CENTS_PE: z.coerce.number().int().positive().default(150),
  COST_PER_KM_CENTS_EC: z.coerce.number().int().positive().default(50),

  // TTL del cache in-proc del costo/km (ms). Slot corto por país; el PUT del admin invalida la réplica que lo
  // atiende de inmediato (autoaplica) y las demás convergen al vencer el TTL (sin acoplar a Kafka).
  COST_PER_KM_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(10_000),
})
  .superRefine((env, ctx) => {
    // Routing SOBERANO fail-fast (§0.7): en prod el gate legal F1b NO puede correr sobre el motor 'local'
    // (estimación determinista de dev/CI, sin red). Prod EXIGE 'osrm' (infra OSM self-hosted), si no el
    // tope de cost-sharing se validaría con distancias aproximadas. Falla temprano y claro al boot.
    if (env.NODE_ENV === 'production' && env.VEO_MAPS_MODE !== 'osrm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VEO_MAPS_MODE'],
        message:
          "En producción VEO_MAPS_MODE debe ser 'osrm' (routing soberano OSM self-hosted, §0.7); 'local' es solo dev/CI.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
