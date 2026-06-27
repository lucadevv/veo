/**
 * Validación de entorno del admin-bff (FOUNDATION §4). Si falta una var requerida, el BFF no arranca.
 * Defaults orientados a dev; nada hardcodeado en lógica de negocio.
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';

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

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4003),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // CORS: origen del admin-web (Next.js). En prod, dominio real. Dev = 5001 (el 5000 lo ocupa AirPlay de macOS).
  ADMIN_WEB_ORIGIN: z.string().default('http://localhost:5001'),

  // JWT ES256 — el BFF es VALIDADOR (clave pública). El issuer/audience deben coincidir con identity-service.
  VEO_JWT_PUBLIC_PEM: z.string().optional(),
  VEO_JWT_ISSUER: z.string().default('veo-identity'),
  VEO_JWT_AUDIENCE: z.string().default('veo-app'),

  // Secreto HMAC para firmar la identidad interna propagada a los servicios (debe coincidir con ellos).
  VEO_INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Redis (rate-limit + read-model CQRS de listados).
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (consumidor de eventos para read-model + tiempo real Socket.IO).
  KAFKA_BROKERS: requiredInProd('localhost:9094'),
  KAFKA_CONSUMER_GROUP: z.string().default('admin-bff'),

  // ClickHouse (analítica vía interfaz HTTP — sin dependencias nuevas).
  CLICKHOUSE_URL: requiredInProd('http://localhost:8123'),
  CLICKHOUSE_DB: z.string().default('veo_analytics'),
  CLICKHOUSE_USER: z.string().default('veo'),
  CLICKHOUSE_PASSWORD: secret('veo_dev'),

  // Rate limiting (Redis, por IP+usuario). POST /panic no aplica aquí (el BFF admin no recibe pánico crudo).
  // .int().positive(): un valor 0/negativo/float reventaría el limiter en runtime → falla al boot (FIX D,
  // conforme a driver-bff). Sin esto, RATE_LIMIT_MAX=0 bloquearía TODO el tráfico silenciosamente.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  // Proxies de confianza para `trust proxy` (Express). CSV de presets/subredes. Default = rangos
  // privados del VPC (ALB + ingress-nginx) → `req.ip` resuelve la IP pública real del cliente, no un
  // header inyectado. Un deploy distinto (p.ej. tras Cloudflare) lo ajusta sin tocar código.
  TRUSTED_PROXY: z.string().default(DEFAULT_TRUSTED_PROXY),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // ── gRPC (LECTURAS) ──
  IDENTITY_GRPC_URL: requiredInProd('localhost:50051'),
  TRIP_GRPC_URL: requiredInProd('localhost:50052'),
  DISPATCH_GRPC_URL: requiredInProd('localhost:50053'),
  PAYMENT_GRPC_URL: requiredInProd('localhost:50055'),
  PANIC_GRPC_URL: requiredInProd('localhost:50056'),
  MEDIA_GRPC_URL: requiredInProd('localhost:50057'),
  AUDIT_GRPC_URL: requiredInProd('localhost:50059'),
  RATING_GRPC_URL: requiredInProd('localhost:50060'),
  FLEET_GRPC_URL: requiredInProd('localhost:50062'),

  // ── REST interno firmado (COMANDOS) — todos /api/v1 ──
  IDENTITY_URL: requiredInProd('http://localhost:3091/api/v1'),
  TRIP_URL: requiredInProd('http://localhost:3092/api/v1'),
  DISPATCH_URL: requiredInProd('http://localhost:3093/api/v1'),
  PAYMENT_URL: requiredInProd('http://localhost:3005/api/v1'),
  PANIC_URL: requiredInProd('http://localhost:3006/api/v1'),
  MEDIA_URL: requiredInProd('http://localhost:3007/api/v1'),
  AUDIT_URL: requiredInProd('http://localhost:3009/api/v1'),
  FLEET_URL: requiredInProd('http://localhost:3012/api/v1'),
  // booking-service (carpooling): el endpoint interno del costo/km del cost-cap (F2.5 · escudo legal). :3016.
  BOOKING_URL: requiredInProd('http://localhost:3016/api/v1'),

  // Bucket S3 donde fleet-service guarda los archivos de documentos del conductor. El admin-bff lo pasa
  // a media-service (POST /media/internal/presign-get) para acuñar URLs GET firmadas en la revisión.
  // Debe coincidir con S3_BUCKET_DOCUMENTS de fleet-service/media-service.
  S3_BUCKET_DOCUMENTS: z.string().default('veo-documents-dev'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
