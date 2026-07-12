/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3005),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks de cron / idempotencia auxiliar)
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto para verificar la identidad interna propagada por el BFF (HMAC). También firma la identidad de
  // SISTEMA con la que el cliente de @veo/policy consulta el registro central (GET /internal/policies).
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Base del API interno de identity-service (registro central de políticas PBAC · ADR-024 Fase 1). El
  // cliente de @veo/policy hace GET /internal/policies (firmado admin-rail) al boot para poblar su cache;
  // si es inalcanzable, cae al DEFAULT del catálogo (fail-safe, nunca tumba el arranque). Incluye /api/v1.
  IDENTITY_INTERNAL_URL: requiredInProd('http://localhost:3001/api/v1', { url: true }),

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
  /// Monto sobre el cual un reembolso exige AUTORIDAD ELEVADA (BR-P06 · dual-control). Bajo el modelo finanzas-only
  /// (refund = FINANCE/ADMIN/SUPERADMIN), un reembolso > este umbral lo puede emitir SOLO ADMIN o SUPERADMIN; un
  /// FINANCE queda topado acá. Recalibrado a S/300 = 30000 céntimos (antes S/30, calibrado para el tier SUPPORT_L1
  /// ya retirado). Nombre del env conservado por compat de config. Tuneable por entorno.
  REFUND_L2_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(30000),
  /// Ventana del BACKSTOP de idempotencia del refund admin (minutos): dos reembolsos del MISMO (paymentId,
  /// céntimos) dentro de esta ventana se tratan como la MISMA operación (devuelve el existente), independiente
  /// del Idempotency-Key del cliente. Cierra el residual del nonce de browser divergente (storage bloqueado,
  /// cross-tab, cross-device). El operador habilita un 2do parcial idéntico legítimo con el gesto `forceNew`.
  /// Default 15 min; tuneable por entorno como sus hermanas REFUND_WINDOW_DAYS / REFUND_L2_THRESHOLD_CENTS.
  REFUND_IDEMPOTENCY_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  /// Fracción de la penalidad de cancelación que va al CONDUCTOR como compensación (F2 · BR-T03). El
  /// resto lo retiene la plataforma. Default 0.5 (50/50).
  CANCELLATION_DRIVER_SHARE: z.coerce.number().min(0).max(1).default(0.5),
  /// Umbral de discrepancia de conciliación que dispara alerta a finanzas (BR-P07). Default 1%.
  RECONCILIATION_ALERT_PCT: z.coerce.number().min(0).max(1).default(0.01),
  /// Red de seguridad del lazo de reembolsos (S5 · BR-P06): un Refund PENDING más viejo que este umbral
  /// (minutos) dispara ALERTA a ops (el callback del proveedor no llegó o no correlacionó). Default 60.
  REFUND_PENDING_ALERT_MIN: z.coerce.number().int().min(1).default(60),
  /// Red de seguridad del efectivo: un pago CASH PENDING más viejo que este umbral (minutos) dispara
  /// ALERTA a ops (el conductor cobró pero el pasajero nunca confirmó). Default 1440 (24h). Solo alerta,
  /// sin cierre automático (capturar sin el OK del pasajero rompería el anti-fraude bilateral).
  CASH_PENDING_ALERT_MIN: z.coerce.number().int().min(1).default(1440),

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

  // ── Riel de DESEMBOLSO tras el puerto PayoutGateway (money-OUT · ADR-015 D2) ──
  /// Selección de adapter money-OUT: `sandbox` (determinista, AHORA) | `live` (Yape/Plin, DIFERIDO PSP).
  /// Default sandbox: en dev el desembolso e2e corre sin PSP real; en prod sin convenio el live falla-rápido.
  PAYOUT_GATEWAY_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  /// Endpoint + credenciales del riel de desembolso real (solo modo live · DIFERIDO).
  PAYOUT_GATEWAY_URL: z.string().optional(),
  PAYOUT_GATEWAY_API_KEY: z.string().optional(),
  PAYOUT_GATEWAY_MERCHANT_ID: z.string().optional(),
  /// Semilla del rechazo determinista del sandbox de desembolso: un amountCents múltiplo de esto se rechaza
  /// permanente (prueba el camino PROCESSING→FAILED sin cuentas reales). 0 ⇒ nunca rechaza por monto.
  SANDBOX_PAYOUT_REJECT_SEED: z.coerce.number().int().min(0).default(13),
  /// Si `true`, el sandbox de desembolso confirma SÍNCRONO (CONFIRMED) en vez de async (SUBMITTED). Default
  /// false (camino normal: el desembolso queda SUBMITTED y confirma por webhook/poll).
  SANDBOX_PAYOUT_CONFIRM_SYNC: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  /// Poll fallback del DESEMBOLSO (ADR-015 §4.2 · espejo del poll del money-IN): consulta el estado de los
  /// payouts PROCESSING al riel (PayoutStatusQuery) cuando el webhook no llega (dev sin túnel) y aplica la
  /// confirmación por el camino idempotente (applyPayoutDisbursementResult). Activable; cierra el ciclo async
  /// money-OUT en dev/e2e. Solo corre si el adapter soporta la consulta (sandbox la implementa; live, al PSP).
  PAYOUT_POLL_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(true),
  /// Cada cuántos ms corre el barrido del poll de desembolso (default 25s).
  PAYOUT_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(25_000),
  /// Solo se consultan payouts PROCESSING actualizados dentro de esta ventana (minutos).
  PAYOUT_POLL_MAX_AGE_MIN: z.coerce.number().int().min(1).default(60),
  /// Máximo de payouts consultados por tick (cota de carga al riel).
  PAYOUT_POLL_BATCH: z.coerce.number().int().min(1).max(200).default(25),

  // ── ProntoPaga (VEO_PAYMENT_MODE=prontopaga) · agregador de pagos Perú ──
  /// Base de la API (tracked). Default sandbox público de ProntoPaga.
  PRONTOPAGA_BASE_URL: z.string().default('https://sandbox.prontopaga.com'),
  /// secretKey para firmar el body (HMAC-SHA256). Vacío en tracked; real en development.env.
  PRONTOPAGA_SECRET_KEY: z.string().optional(),
  /// Token estático del sandbox público (alternativa a username/password). En development.env.
  PRONTOPAGA_API_TOKEN: z.string().optional(),
  /// Credenciales de sign-in (alternativa al token estático). En development.env.
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
