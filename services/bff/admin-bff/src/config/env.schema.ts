/**
 * Validación de entorno del admin-bff (FOUNDATION §4). Si falta una var requerida, el BFF no arranca.
 * Defaults orientados a dev; nada hardcodeado en lógica de negocio.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4003),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // CORS: origen del admin-web (Next.js). En prod, dominio real.
  ADMIN_WEB_ORIGIN: z.string().default('http://localhost:5000'),

  // JWT ES256 — el BFF es VALIDADOR (clave pública). El issuer/audience deben coincidir con identity-service.
  VEO_JWT_PUBLIC_PEM: z.string().optional(),
  VEO_JWT_ISSUER: z.string().default('veo-identity'),
  VEO_JWT_AUDIENCE: z.string().default('veo-app'),

  // Secreto HMAC para firmar la identidad interna propagada a los servicios (debe coincidir con ellos).
  VEO_INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Redis (rate-limit + read-model CQRS de listados).
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (consumidor de eventos para read-model + tiempo real Socket.IO).
  KAFKA_BROKERS: z.string().default('localhost:9094'),
  KAFKA_CONSUMER_GROUP: z.string().default('admin-bff'),

  // ClickHouse (analítica vía interfaz HTTP — sin dependencias nuevas).
  CLICKHOUSE_URL: z.string().default('http://localhost:8123'),
  CLICKHOUSE_DB: z.string().default('veo_analytics'),
  CLICKHOUSE_USER: z.string().default('veo'),
  CLICKHOUSE_PASSWORD: secret('veo_dev'),

  // Rate limiting (Redis, por IP+usuario). POST /panic no aplica aquí (el BFF admin no recibe pánico crudo).
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(120),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // ── gRPC (LECTURAS) ──
  IDENTITY_GRPC_URL: z.string().default('localhost:50051'),
  TRIP_GRPC_URL: z.string().default('localhost:50052'),
  DISPATCH_GRPC_URL: z.string().default('localhost:50053'),
  PAYMENT_GRPC_URL: z.string().default('localhost:50055'),
  PANIC_GRPC_URL: z.string().default('localhost:50056'),
  MEDIA_GRPC_URL: z.string().default('localhost:50057'),
  AUDIT_GRPC_URL: z.string().default('localhost:50059'),
  RATING_GRPC_URL: z.string().default('localhost:50060'),
  FLEET_GRPC_URL: z.string().default('localhost:50062'),

  // ── REST interno firmado (COMANDOS) — todos /api/v1 ──
  IDENTITY_URL: z.string().default('http://localhost:3001/api/v1'),
  TRIP_URL: z.string().default('http://localhost:3002/api/v1'),
  DISPATCH_URL: z.string().default('http://localhost:3003/api/v1'),
  PAYMENT_URL: z.string().default('http://localhost:3005/api/v1'),
  PANIC_URL: z.string().default('http://localhost:3006/api/v1'),
  MEDIA_URL: z.string().default('http://localhost:3007/api/v1'),
  AUDIT_URL: z.string().default('http://localhost:3009/api/v1'),
  FLEET_URL: z.string().default('http://localhost:3012/api/v1'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
