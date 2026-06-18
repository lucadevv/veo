/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 * notification-service: motor propio de notificaciones (cola, dedup, retry) + canales tras puertos.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';
import { PushMode, PushTransportKey } from '../ports/push/push.port';
import { SmsProvider } from '../ports/sms/sms.port';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3008),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks del worker / coordinación ligera)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores de dominio)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto para verificar la identidad interna que el BFF propaga (InternalIdentityGuard)
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Locale por defecto del dominio (Lima/Perú)
  DEFAULT_LOCALE: z.string().default('es-PE'),

  // ---- Motor de reintentos / cola ----
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  NOTIFICATION_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  NOTIFICATION_BACKOFF_FACTOR: z.coerce.number().positive().default(2),
  NOTIFICATION_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000), // 5 min
  NOTIFICATION_RETRY_JITTER: z.coerce.boolean().default(true),
  NOTIFICATION_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  NOTIFICATION_WORKER_BATCH: z.coerce.number().int().positive().default(50),

  // ---- Selección de adapter por canal (default sandbox = determinista en consola) ----
  VEO_PUSH_MODE: z.enum([PushMode.Sandbox, PushMode.Live]).default(PushMode.Sandbox),
  /// Flag SMS LEGADO (backward-compat): live→smpp, sandbox→sandbox. Sigue funcionando si SMS_PROVIDER no está.
  VEO_SMS_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  /// Proveedor SMS explícito (fuente única nueva). Si se define, manda sobre VEO_SMS_MODE. Default LOCAL: sandbox.
  SMS_PROVIDER: z
    .enum([SmsProvider.Sandbox, SmsProvider.Smpp, SmsProvider.Twilio, SmsProvider.WhatsApp])
    .optional(),
  VEO_EMAIL_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  VEO_WEBHOOK_MODE: z.enum(['live', 'sandbox']).default('sandbox'),

  // ---- PUSH: FCM HTTP v1 (google-auth-library) ----
  FCM_PROJECT_ID: z.string().optional(),
  /// Ruta al JSON de la service account (GoogleAuth la lee de GOOGLE_APPLICATION_CREDENTIALS si no se pasa).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  /// Alternativa: JSON inline de la service account.
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // ---- PUSH iOS · riel de transporte (puerto intercambiable, FOUNDATION §0.7) ----
  /// 'fcm' (default): iOS viaja por FCM HTTP v1; Google entrega a APNs con la APNs key cargada en la
  /// consola de Firebase. La app registra el token FCM (RNFirebase getToken) para ambas plataformas.
  /// 'apns': iOS viaja DIRECTO a Apple por el cliente APNs HTTP/2 soberano (requiere que la app registre
  /// el token APNs crudo vía getAPNSToken). Conmutable sin tocar código: cambia este flag.
  PUSH_IOS_TRANSPORT: z
    .enum([PushTransportKey.Fcm, PushTransportKey.Apns])
    .default(PushTransportKey.Fcm),

  // ---- PUSH: APNs HTTP/2 (token JWT ES256 firmado con node:crypto) ----
  APNS_KEY_P8: z.string().optional(), // clave .p8 (PEM EC P-256)
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(), // apns-topic
  APNS_HOST: z.string().default('https://api.sandbox.push.apple.com'),

  // ---- SMS: SMPP 3.4 directo a operador (implementación propia sobre TCP) ----
  SMPP_HOST: z.string().optional(),
  SMPP_PORT: z.coerce.number().int().positive().default(2775),
  SMPP_SYSTEM_ID: z.string().optional(),
  SMPP_PASSWORD: z.string().optional(),
  SMPP_SOURCE_ADDR: z.string().default('VEO'),
  SMPP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ---- SMS: Twilio REST (raw fetch) — solo si SMS_PROVIDER=twilio ----
  /// AccountSid (AC…) y AuthToken son SECRETOS (van en el env gitignored). From/MessagingServiceSid: uno u otro.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(), // número remitente E.164 (excluyente con MessagingServiceSid)
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(), // MG… (excluyente con From)
  TWILIO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ---- SMS: WhatsApp Cloud API (Meta Graph) — solo si SMS_PROVIDER=whatsapp ----
  /// PhoneNumberId y AccessToken son SECRETOS (env gitignored). Template debe estar pre-aprobado por Meta.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_OTP_TEMPLATE: z.string().optional(), // nombre del template de autenticación aprobado
  WHATSAPP_OTP_LANG: z.string().default('es'), // código de idioma del template
  WHATSAPP_GRAPH_VERSION: z.string().default('v25.0'), // versión de Graph anclada
  WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ---- EMAIL: SMTP propio (nodemailer). Dev → Mailpit localhost:1025 ----
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('VEO <no-reply@veo.pe>'),

  // ---- WEBHOOK: HTTP firmado (HMAC-SHA256) ----
  WEBHOOK_SIGNING_SECRET: secret('dev-webhook-secret-change-me'),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  /// Destino de alertas hacia la central de monitoreo (pánico / pagos críticos).
  CENTRAL_ALERT_WEBHOOK_URL: z.string().optional(),

  // ---- gRPC downstream ----
  /// share-service (lectura síncrona): resuelve teléfonos+nombres de contactos para el fan-out de
  /// pánico (panic.fanout_requested). El payload Kafka no transporta PII; se resuelve acá por gRPC.
  SHARE_GRPC_URL: z.string().default('localhost:50059'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
