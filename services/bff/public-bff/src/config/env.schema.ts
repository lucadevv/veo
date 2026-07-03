/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el BFF no arranca.
 * El public-bff es un agregador sin base de datos propia: valida JWT, propaga identidad interna
 * firmada (HMAC) aguas abajo y habla con los microservicios vía gRPC (lecturas) y REST interno (comandos).
 */
import { z } from 'zod';
import { isHardenedEnv, requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { MAPS_MODES } from '@veo/maps';

/**
 * Preset de proxies de CONFIANZA para `trust proxy` (Express/proxy-addr). Son los rangos de IP
 * INTERNOS del VPC (loopback 127/8 + ::1, link-local 169.254/16 + fe80::/10, y unique-local:
 * 10/8 + 172.16/12 + 192.168/16 + fc00::/7). El ALB y el ingress-nginx tienen IP privada → caen
 * acá; el CLIENTE real tiene IP PÚBLICA → NUNCA está en esta lista. Con esto Express camina el
 * `X-Forwarded-For` de derecha a izquierda descartando los hops privados y resuelve `req.ip` = la
 * primera IP pública = el cliente real (un-spoofeable). NO usamos un NÚMERO de hops: es frágil
 * (un hop falso del atacante o un cambio de topología lo rompe). Configurable vía TRUSTED_PROXY.
 */
export const DEFAULT_TRUSTED_PROXY = 'loopback, linklocal, uniquelocal';

/**
 * Default de desarrollo del puerto de señalización LiveKit. Fuente única (sin string mágico esparcido):
 * lo usa tanto el `.default()` del campo como el fail-fast condicional del `superRefine` de abajo.
 */
const DEV_LIVEKIT_URL = 'ws://localhost:7880';

export const envSchema = z
  .object({
    // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
    // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
    ...grpcTlsEnvSchema.shape,
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
    REDIS_URL: requiredInProd('redis://localhost:6379'),
    KAFKA_BROKERS: requiredInProd('localhost:9094'),

    // ── Mapas. Modos: `osrm`/`local` (OSM self-hosted, soberanía §0.7) o `mapbox` (APIs HTTP de
    //    Mapbox con token público `pk`, server-side). Todos degradan al motor local ante fallo. ──
    VEO_MAPS_MODE: z.enum(MAPS_MODES).default('osrm'),
    OSRM_URL: z.string().default('http://localhost:5000'),
    NOMINATIM_URL: z.string().default('http://localhost:8080'),
    // Token público de Mapbox (`pk....`). Obligatorio solo cuando VEO_MAPS_MODE=mapbox.
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    // ── Pricing (ADR 011 M4). El piso de la PUJA ya NO vive en env: el quote lo trae de trip-service
    // (GET /internal/pricing/bid-floor) y lo resuelve per-oferta con resolveBidFloorCents (ADR 010 §9.3). ──
    // B5-1.d · FLIP del modelo de energía en el quote. OFF (default) = fórmula vieja (fuel global); ON =
    // fórmula nueva (energía pass-through por oferta · multiplier solo posición). Espeja trip-service.
    PRICING_ENERGY_MODEL_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),

    // ── gRPC downstream (lecturas) ──
    IDENTITY_GRPC_URL: requiredInProd('localhost:50051'),
    TRIP_GRPC_URL: requiredInProd('localhost:50052'),
    DISPATCH_GRPC_URL: requiredInProd('localhost:50053'),
    PAYMENT_GRPC_URL: requiredInProd('localhost:50055'),
    PANIC_GRPC_URL: requiredInProd('localhost:50056'),
    RATING_GRPC_URL: requiredInProd('localhost:50060'),
    SHARE_GRPC_URL: requiredInProd('localhost:50061'),
    FLEET_GRPC_URL: requiredInProd('localhost:50062'),
    // places-service (Lote B): lugares guardados del pasajero (CRUD gRPC).
    PLACES_GRPC_URL: requiredInProd('localhost:50063'),
    GRPC_DEADLINE_MS: z.coerce.number().default(5000),

    // ── REST interno downstream (comandos). baseUrl = http://localhost:300X/api/v1 ──
    IDENTITY_URL: requiredInProd('http://localhost:3001/api/v1'),
    TRIP_URL: requiredInProd('http://localhost:3002/api/v1'),
    // dispatch-service — comandos REST de la PUJA (listar/aceptar/cancelar ofertas del board).
    DISPATCH_URL: requiredInProd('http://localhost:3003/api/v1'),
    PAYMENT_URL: requiredInProd('http://localhost:3005/api/v1'),
    PANIC_URL: requiredInProd('http://localhost:3006/api/v1'),
    SHARE_URL: requiredInProd('http://localhost:3011/api/v1'),
    RATING_URL: requiredInProd('http://localhost:3010/api/v1'),
    NOTIFICATION_URL: requiredInProd('http://localhost:3008/api/v1'),
    // chat-service (Ola 2A) — historial + persistencia de mensajes; la entrega RT la hace este BFF.
    CHAT_URL: requiredInProd('http://localhost:3014/api/v1'),
    // media-service — presign de subida del avatar (PUT directo a MinIO/S3).
    MEDIA_URL: requiredInProd('http://localhost:3007/api/v1'),
    // booking-service (ADR-014 · carpooling, lado PASAJERO): búsqueda pública de viajes publicados +
    // detalle enriquecido + reservar asiento + seguir MI reserva (espeja BOOKING_SERVICE_URL del driver-bff).
    BOOKING_URL: requiredInProd('http://localhost:3016/api/v1'),
    REST_TIMEOUT_MS: z.coerce.number().default(8000),

    // ── Rate limiting (Redis). POST /panic JAMÁS se limita (BR / FOUNDATION §14). ──
    // .int().positive(): coherente con driver/admin-bff (FIX D). Un 0/negativo/float reventaría el
    // limiter en runtime → falla al boot en vez de bloquear todo el tráfico silenciosamente.
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

    // Proxies de confianza para `trust proxy` (Express). CSV de presets/subredes. Default = rangos
    // privados del VPC (ALB + ingress-nginx) → `req.ip` resuelve la IP pública real del cliente, no un
    // header inyectado. Un deploy distinto (p.ej. tras Cloudflare) lo ajusta sin tocar código.
    TRUSTED_PROXY: z.string().default(DEFAULT_TRUSTED_PROXY),

    // ── LiveKit self-hosted (video del habitáculo, soberanía §0.7). ──
    // Si falta API_KEY/API_SECRET el video queda DESHABILITADO (la web familiar degrada a "sin video").
    // El token de viewer (solo suscripción) se firma HS256 con el secreto; nunca se inventan credenciales.
    LIVEKIT_URL: z.string().default(DEV_LIVEKIT_URL),
    LIVEKIT_API_KEY: z.string().default(''),
    LIVEKIT_API_SECRET: z.string().default(''),
    LIVEKIT_GRANT_TTL_SEC: z.coerce.number().default(3600),

    // ── CORS (lista separada por comas; '*' permite cualquiera) ──
    CORS_ORIGINS: z.string().default('*'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // En modo `mapbox` el token público `pk` es obligatorio: sin él no se puede hablar con la API.
    if (env.VEO_MAPS_MODE === 'mapbox' && !env.MAPBOX_ACCESS_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAPBOX_ACCESS_TOKEN'],
        message: 'MAPBOX_ACCESS_TOKEN es obligatorio cuando VEO_MAPS_MODE=mapbox',
      });
    }

    // LiveKit en prod (fail-fast CONDICIONAL): el video familiar es degradable a propósito — sin
    // LIVEKIT_API_KEY el viewer se apaga ("sin video") y la URL es irrelevante. PERO si está HABILITADO
    // (API_KEY presente) en un entorno endurecido, la URL no puede quedar en el localhost de dev: apuntaría
    // a un server LiveKit inexistente y el viewer familiar se caería en silencio. No se fuerza incondicional
    // (eso rompería el boot del modo degradado, el mismo error que evitamos con OSRM/NOMINATIM mode-gated).
    if (isHardenedEnv() && env.LIVEKIT_API_KEY && env.LIVEKIT_URL === DEV_LIVEKIT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LIVEKIT_URL'],
        message:
          'LIVEKIT_URL no puede ser el default de desarrollo en producción cuando LiveKit está habilitado ' +
          '(LIVEKIT_API_KEY presente): apunta a un server de señalización inexistente.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Valida y normaliza el entorno de proceso. Lanza si una var requerida falta o es inválida. */
export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
