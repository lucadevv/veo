/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3005),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks de cron / idempotencia auxiliar)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto para verificar la identidad interna propagada por el BFF (HMAC)
  INTERNAL_IDENTITY_SECRET: z.string().default('dev-internal-secret-change-me'),

  // ── Dominio de pagos ──
  /// Take rate de plataforma 0..1 (BR-P04). Default 20%.
  COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.2),
  /// Reintentos contra el riel Yape/Plin antes de marcar DEBT (BR-P02).
  PAYMENT_MAX_RETRIES: z.coerce.number().int().min(1).default(3),
  /// Base del backoff exponencial entre reintentos (ms). En test se baja a ~1.
  PAYMENT_RETRY_BASE_MS: z.coerce.number().int().min(0).default(500),
  /// Método por defecto al cobrar desde el evento trip.completed (el BFF puede precisar otro).
  DEFAULT_PAYMENT_METHOD: z.enum(['YAPE', 'PLIN', 'CASH', 'CARD']).default('YAPE'),
  /// Monto mínimo para liquidar un payout (BR-P05). Default S/50 = 5000 céntimos.
  PAYOUT_MIN_CENTS: z.coerce.number().int().min(0).default(5000),
  /// Umbral (0..1) de step-up MFA para correr payouts de monto alto (BR-S07). Default S/5000.
  PAYOUT_STEPUP_CENTS: z.coerce.number().int().min(0).default(500_000),
  /// Ventana para solicitar reembolso (BR-P06). Default 7 días.
  REFUND_WINDOW_DAYS: z.coerce.number().int().min(0).default(7),
  /// Monto sobre el cual un reembolso requiere aprobación L2 (BR-P06). Default S/30 = 3000 céntimos.
  REFUND_L2_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(3000),
  /// Fracción de la penalidad de cancelación que va al CONDUCTOR como compensación (F2 · BR-T03). El
  /// resto lo retiene la plataforma. Default 0.5 (50/50).
  CANCELLATION_DRIVER_SHARE: z.coerce.number().min(0).max(1).default(0.5),
  /// Umbral de discrepancia de conciliación que dispara alerta a finanzas (BR-P07). Default 1%.
  RECONCILIATION_ALERT_PCT: z.coerce.number().min(0).max(1).default(0.01),

  // ── Riel externo tras el puerto PaymentGateway ──
  /// Selección de adapter: `live` (API directa) | `sandbox` (determinista) | `prontopaga` (agregador PE).
  VEO_PAYMENT_MODE: z.enum(['live', 'sandbox', 'prontopaga']).default('sandbox'),
  /// Endpoint del riel real (solo modo live).
  PAYMENT_GATEWAY_URL: z.string().optional(),
  /// Credenciales del riel real (solo modo live).
  PAYMENT_GATEWAY_API_KEY: z.string().optional(),
  PAYMENT_GATEWAY_MERCHANT_ID: z.string().optional(),
  /// Latencia simulada de confirmación del adapter sandbox (ms).
  SANDBOX_CONFIRM_DELAY_MS: z.coerce.number().int().min(0).default(50),
  /// Sufijo de payerRef que el adapter sandbox declina de forma determinista (para pruebas de DEBT).
  SANDBOX_DECLINE_SUFFIX: z.string().default('0000'),
  /// Si `true`, el adapter sandbox NO captura síncrono: devuelve PENDING_EXTERNAL y espera webhook
  /// (espeja a ProntoPaga; para e2e/smoke del flujo asíncrono sin red). Default false (compat).
  SANDBOX_PENDING_EXTERNAL: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  /// Secret HMAC para firmar/verificar webhooks SIMULADOS del adapter sandbox (e2e/smoke).
  SANDBOX_WEBHOOK_SECRET: z.string().default('dev-sandbox-webhook-secret'),

  // ── ProntoPaga (VEO_PAYMENT_MODE=prontopaga) · agregador de pagos Perú ──
  /// Base de la API (tracked). Default sandbox público de ProntoPaga.
  PRONTOPAGA_BASE_URL: z.string().default('https://sandbox.prontopaga.com'),
  /// secretKey para firmar el body (HMAC-SHA256). Vacío en tracked; real en dev.secret.env.
  PRONTOPAGA_SECRET_KEY: z.string().optional(),
  /// Token estático del sandbox público (alternativa a username/password). En dev.secret.env.
  PRONTOPAGA_API_TOKEN: z.string().optional(),
  /// Credenciales de sign-in (alternativa al token estático). En dev.secret.env.
  PRONTOPAGA_USERNAME: z.string().optional(),
  PRONTOPAGA_PASSWORD: z.string().optional(),
  /// Base pública para armar urlConfirmation del webhook (`${base}/api/v1/webhooks/prontopaga`).
  /// OJO: ProntoPaga (Cloudflare) RECHAZA con 403 las urls `http://localhost` (las trata como SSRF).
  /// En local sin túnel el webhook NO llega → el poll fallback (abajo) resuelve el estado. En prod
  /// apuntar a la URL pública del webhook (entonces el webhook firmado es el camino principal).
  PRONTOPAGA_WEBHOOK_BASE_URL: z.string().default('http://localhost:3005'),

  /// Poll fallback (modo prontopaga): consulta GET /api/payment/data/{uid} para pagos PENDING cuyo
  /// webhook no llegó (local sin túnel). Activable; en prod con webhook público puede quedar como red de
  /// seguridad. Intervalo, antigüedad máxima de los pagos a barrer y tope por tick (carga suave).
  PRONTOPAGA_POLL_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(true),
  /// Cada cuántos ms corre el barrido del poll fallback (default 25s).
  PRONTOPAGA_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(25_000),
  /// Solo se consultan pagos creados dentro de esta ventana (minutos) — no barremos historia vieja.
  PRONTOPAGA_POLL_MAX_AGE_MIN: z.coerce.number().int().min(1).default(60),
  /// Máximo de pagos consultados por tick (cota de carga al proveedor).
  PRONTOPAGA_POLL_BATCH: z.coerce.number().int().min(1).max(200).default(25),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios)
  GRPC_URL: z.string().default('0.0.0.0:50055'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
