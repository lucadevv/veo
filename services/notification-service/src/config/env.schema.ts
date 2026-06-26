/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 * notification-service: motor propio de notificaciones (cola, dedup, retry) + canales tras puertos.
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { PushMode, PushTransportKey } from '../ports/push/push.port';
import { SmsProvider } from '../ports/sms/sms.port';
import { outboxEnvSchema } from '@veo/database';

/**
 * Modos de puerto intercambiable EMAIL (enum tipado, fuente única — sin string mágico esparcido). `live`
 * usa el SMTP real; `sandbox` solo loguea, no envía. El fail-fast productivo (superRefine) compara contra
 * `LIVE_MODE`, la constante tipada — nunca contra un literal `'live'` suelto. (PUSH y SMS tienen sus
 * propias constantes tipadas en sus puertos: `PushMode.Live` y `SmsProvider.*`.)
 */
export const PORT_MODES = ['live', 'sandbox'] as const;
export const LIVE_MODE = 'live' satisfies (typeof PORT_MODES)[number];

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3008),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (locks del worker / coordinación ligera)
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores de dominio)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

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
  VEO_EMAIL_MODE: z.enum(PORT_MODES).default('sandbox'),
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
  SHARE_GRPC_URL: requiredInProd('localhost:50061'),

  /// identity-service (lectura síncrona): resuelve `driverId → userId` para los pushes que targetean al
  /// conductor por su `Driver.id` (ADR-015 D7 · payout.processed). El device-token store se consulta por
  /// `userId`; sin esta resolución el push al conductor se omitía siempre (Driver.id ≠ userId). Mismo
  /// default-coherente que booking-service (apunta al puerto gRPC real de identity).
  IDENTITY_GRPC_URL: requiredInProd('localhost:50051'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
}).superRefine((env, ctx) => {
  // FAIL-FAST DE SEGURIDAD (regla ENTORNOS · diferenciador VEO): en un entorno PRODUCTIVO (internet-facing)
  // TODOS los canales de entrega DEBEN apuntar a un proveedor REAL. `NODE_ENV=production` es la señal canónica
  // de "entorno endurecido" del repo (cubre preview Y prod, ver @veo/utils isHardenedEnv) — el MISMO criterio
  // que `secret()` usa para rechazar secretos de dev. En sandbox cada canal usa un sustituto que SOLO loguea y
  // NO entrega (SMS sandbox loguea el OTP en claro, email sandbox loguea el correo, push sandbox no llega al
  // device): en producción cualquiera de esos es login/notificaciones rotas + fuga de datos. En local/development
  // sandbox SIGUE permitido (no rompe el dev/CI sin proveedores reales).
  //
  // MATIZ — predicado POR ENTRADA: cada canal define su propia condición de "está en producción-seguro" porque
  // NO comparten forma. EMAIL y PUSH son MODOS (basta `=== live`). SMS es distinto: la fuente ACTIVA es
  // `SMS_PROVIDER` (un proveedor concreto: smpp/twilio/whatsapp), no un modo live/sandbox — debe estar DEFINIDO y
  // NO ser `sandbox`. Por eso la tabla lleva un `check(env) => boolean` por fila, manteniendo un solo loop (DRY)
  // sin forzar a todos al mismo predicado. Todo contra constantes tipadas (`SmsProvider.Sandbox`, `PushMode.Live`,
  // `LIVE_MODE`) — nunca contra el literal `'live'`/`'sandbox'` esparcido.
  //
  // VEO_SMS_MODE NO se valida acá A PROPÓSITO: es código MUERTO. `resolveProvider()` en sms.module.ts hace
  // `if (SMS_PROVIDER) return SMS_PROVIDER` ANTES de leer VEO_SMS_MODE — con `SMS_PROVIDER` definido (lo que este
  // gate EXIGE en prod), VEO_SMS_MODE jamás se evalúa. Validar su valor sería endurecer un flag que en producción
  // ya no decide nada: arreglar un fantasma. La fuente única real en prod es `SMS_PROVIDER`.
  type ResolvedEnv = typeof env;
  const PRODUCTION_LIVE_CHANNELS = [
    {
      env: 'SMS_PROVIDER',
      // Definido Y distinto de sandbox: undefined cae a sandbox (resolveProvider), y 'sandbox' explícito solo
      // loguea el OTP sin enviarlo. Solo un proveedor real (smpp/twilio/whatsapp) entrega el SMS.
      check: (e: ResolvedEnv): boolean =>
        e.SMS_PROVIDER !== undefined && e.SMS_PROVIDER !== SmsProvider.Sandbox,
      reason:
        'sin un SMS_PROVIDER real (smpp/twilio/whatsapp) los SMS no se envían (sandbox solo loguea el OTP en claro)',
    },
    {
      env: 'VEO_EMAIL_MODE',
      check: (e: ResolvedEnv): boolean => e.VEO_EMAIL_MODE === LIVE_MODE,
      reason: 'el modo sandbox solo loguea los correos, no los envía',
    },
    {
      env: 'VEO_PUSH_MODE',
      check: (e: ResolvedEnv): boolean => e.VEO_PUSH_MODE === PushMode.Live,
      reason: 'el modo sandbox no entrega push reales (FCM/APNs)',
    },
  ] as const;

  if (env.NODE_ENV === 'production') {
    for (const channel of PRODUCTION_LIVE_CHANNELS) {
      if (!channel.check(env)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [channel.env],
          message: `${channel.env} debe apuntar a un proveedor real en entornos productivos (NODE_ENV=production): ${channel.reason}`,
        });
      }
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
