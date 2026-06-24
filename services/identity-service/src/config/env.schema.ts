/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { requiredInProd, secret } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

/**
 * Modos de puerto intercambiable (enum tipado, fuente única — sin string mágico esparcido). `live` usa el
 * proveedor real/propio; `sandbox` usa un sustituto inseguro para dev/CI (loguea, no envía, no verifica firma,
 * deriva embeddings de sha256). El fail-fast de entorno productivo (superRefine) compara contra `LIVE_MODE`,
 * la constante tipada — nunca contra un literal `'live'` esparcido.
 */
export const PORT_MODES = ['live', 'sandbox'] as const;
export const LIVE_MODE = 'live' satisfies (typeof PORT_MODES)[number];

/**
 * Alias retrocompatibles del puerto biométrico. Conservados para no romper imports existentes; ambos apuntan
 * a la fuente única (`PORT_MODES`/`LIVE_MODE`).
 */
export const BIOMETRIC_MODES = PORT_MODES;
export const BIOMETRIC_LIVE_MODE = LIVE_MODE;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3001),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Base de datos (read/write split)
    DATABASE_URL: z.string().url(),
    DATABASE_URL_REPLICA: z.string().url().optional(),

    // Redis (OTP store + refresh sessions + rate limit)
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // Kafka (outbox relay)
    KAFKA_BROKERS: requiredInProd('localhost:9094'),

    // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
    // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
    // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
    ...outboxEnvSchema.shape,

    // JWT ES256 — PEM por env. En dev, si faltan, se generan claves efímeras.
    JWT_PRIVATE_KEY_PEM: z.string().optional(),
    JWT_PUBLIC_KEY_PEM: z.string().optional(),
    JWT_ISSUER: z.string().default('veo-identity'),
    JWT_AUDIENCE: z.string().default('veo-app'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    REFRESH_TTL_SECONDS: z.coerce.number().default(2_592_000), // 30d

    // Secreto para firmar la identidad interna que el BFF propaga a servicios
    INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

    // Salt para hash de DNI (PII; nunca el DNI en claro)
    DNI_HASH_SALT: secret('dev-dni-salt-change-me'),

    // Clave para cifrar el secreto TOTP de operadores en reposo (KMS en prod)
    TOTP_ENC_KEY: secret('dev-totp-enc-key-change-me'),

    // Clave para cifrar el DNI del conductor en reposo (PII Ley 29733 · AES-256-GCM secret-box). Cifrado
    // REVERSIBLE (no hash): compliance descifra para mostrarlo al operador. `secret()` → fail-fast en prod
    // (requerido + rechaza el valor de dev). KMS en prod, NO compartir con otros servicios.
    DRIVER_DNI_ENC_KEY: secret('dev-driver-dni-enc-key-change-me'),

    // URL pública del panel admin-web (NO secreto). Base del link de invitación de operadores
    // (`${ADMIN_WEB_URL}/accept-invite?token=...`). Requerida: fail-fast si falta.
    ADMIN_WEB_URL: z.string().url(),

    // Días de gracia antes del tombstone por derecho al olvido (BR-S06)
    DELETION_GRACE_DAYS: z.coerce.number().default(30),

    // ── Auto-suspensión por EXCESO DE CANCELACIONES (decisión del dueño · compliance/seguridad) ──
    /// COOLDOWN (horas) del hold TEMPORAL EXCESSIVE_CANCELLATIONS: al suspender, `expiresAt = now + esto`. El
    /// sweeper de holds lo auto-levanta al vencer. Default 24h. (Una re-entrega de Kafka NO extiende el cooldown:
    /// el upsert en conflicto del unique es no-op — no toca expiresAt.)
    EXCESSIVE_CANCELLATION_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
    /// Intervalo (minutos) del @Cron que barre los holds temporales vencidos (`expiresAt < now`) y recomputa
    /// `suspendedAt`. Lag de minutos sobre un cooldown de horas = despreciable. Default 10 min.
    HOLD_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(10),

    // ── Referidos (Ola 2A) ──
    /// Recompensa al referidor cuando el referido completa su 1er viaje (céntimos PEN). Default S/5.
    REFERRAL_REWARD_CENTS: z.coerce.number().int().min(0).default(500),

    // OTP
    OTP_TTL_SECONDS: z.coerce.number().default(300), // 5 min (BR-I06)
    OTP_MAX_ATTEMPTS: z.coerce.number().default(3),

    // ── Correo+contraseña (ADR-012 Lote 2) ──
    /// Códigos efímeros de verificación de correo y reset de contraseña (Redis, hasheados).
    EMAIL_VERIFY_TTL_SECONDS: z.coerce.number().default(600), // 10 min
    PWD_RESET_TTL_SECONDS: z.coerce.number().default(3_600), // 1 h
    EMAIL_CODE_MAX_ATTEMPTS: z.coerce.number().default(5),

    /// Lockout anti brute-force de login por correo+contraseña (Redis, por email).
    LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5), // fallos antes de bloquear
    LOGIN_LOCK_SECONDS: z.coerce.number().default(900), // 15 min de bloqueo + ventana de conteo

    // Puerto EMAIL (SMTP propio). Sandbox por defecto: loguea, no envía. Live → Mailpit en dev.
    VEO_EMAIL_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().default(1025), // Mailpit
    SMTP_SECURE: z.coerce.boolean().default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('VEO <no-reply@veo.pe>'),

    // ── Google OAuth SOBERANO (ADR-012 Lote 3) ──
    // Puerto OAUTH. sandbox: acepta id_token de fixture (base64url) sin verificar firma (dev/CI/tests).
    // live: verifica el id_token contra el JWKS de Google (firma+iss+aud+exp) con jose.
    VEO_OAUTH_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
    /// GOOGLE_CLIENT_ID por plataforma (iOS/Android/Web) como lista separada por coma. Cualquiera es
    /// `aud` válido. Requerido solo en modo live (el factory lanza si falta).
    GOOGLE_CLIENT_ID: z.string().optional(),
    /// APPLE_CLIENT_ID = Bundle ID(s) de la app (flujo nativo Sign in with Apple) como lista separada
    /// por coma. Cualquiera es `aud` válido. Opcional: si falta en modo live, default `pe.veo.passenger`.
    APPLE_CLIENT_ID: z.string().default('pe.veo.passenger'),

    // Puertos externos (modo propio/sandbox por defecto)
    VEO_SMS_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
    /// Base del notification-service (API interna) al que el adaptador SMS LIVE delega el OTP por REST
    /// FIRMADO (POST /notifications). Solo se usa cuando VEO_SMS_MODE=live; el módulo hace getOrThrow,
    /// así que apuntar al notification real antes de activar live. Default: notification del dev-stack.
    NOTIFICATION_INTERNAL_URL: z.string().url().default('http://localhost:3008/api/v1'),
    /// Timeout (ms) de la llamada saliente a notification-service. El OTP debe fallar RÁPIDO Y HONESTO
    /// (502 reintentable) si notification se cuelga, en vez de colgar el login del usuario.
    NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
    VEO_BIOMETRIC_MODE: z.enum(BIOMETRIC_MODES).default('sandbox'),
    BIOMETRIC_SERVICE_URL: z.string().default('http://localhost:3015'),
    /// Score mínimo (0..100) de liveness/match para aprobar verificación de turno (BR-I02). Es el MISMO
    /// umbral que biometric-service VEO_BIO_MATCH_THRESHOLD pero en escala 0..100 (score = coseno*100).
    /// Default 40: alineado a 0.40 (franja oficial InsightFace 0.30–0.45 para buffalo_l). El 90 anterior
    /// rechazaba conductores legítimos (same-person ArcFace ~0.3–0.45). Calibrar con validation set real.
    BIOMETRIC_MIN_SCORE: z.coerce.number().default(40),
    /// Timeout (ms) de las llamadas salientes a biometric-service (Python/ONNX). Es el gate del
    /// inicio de turno (shift-start) + enroll + KYC: si el proveedor de inferencia se cuelga bajo
    /// carga, el request debe FALLAR RÁPIDO Y HONESTO (502 reintentable) en vez de apilar sockets de
    /// TODA la flota. Default 20s: holgado para una inferencia ONNX normal (más que los 8-10s del
    /// resto de clientes salientes, porque liveness+match es más caro), pero acotado.
    BIOMETRIC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // gRPC (lectura síncrona desde otros servicios)
    GRPC_URL: z.string().default('0.0.0.0:50051'),
  })
  .superRefine((env, ctx) => {
    // FAIL-FAST DE SEGURIDAD (regla ENTORNOS · diferenciador VEO): en un entorno PRODUCTIVO (internet-facing)
    // TODOS los puertos intercambiables DEBEN estar en `live`. `NODE_ENV=production` es la señal canónica de
    // "entorno endurecido" del repo (cubre preview Y prod, ver @veo/utils isHardenedEnv) — el MISMO criterio
    // que `secret()` usa para rechazar secretos de dev. En `sandbox` cada puerto usa un sustituto inseguro
    // (biometría decorativa, OTP en claro al log sin enviar SMS, OAuth que acepta id_token forjado sin verificar
    // firma, emails solo logueados): en producción cualquiera de esos es un agujero de seguridad/funcionalidad.
    // En local/development `sandbox` SIGUE permitido (no rompe el dev/CI sin device ni proveedores reales).
    // DRY + sin string mágico: un solo loop sobre la tabla de puertos, comparando contra `LIVE_MODE` (la
    // constante tipada) — nunca contra el literal `'live'` esparcido.
    const PRODUCTION_LIVE_PORTS = [
      {
        env: 'VEO_BIOMETRIC_MODE',
        value: env.VEO_BIOMETRIC_MODE,
        reason: 'el modo sandbox vuelve la biometría decorativa (el embedding es sha256(photo))',
      },
      {
        env: 'VEO_OAUTH_MODE',
        value: env.VEO_OAUTH_MODE,
        reason: 'el modo sandbox acepta id_token forjado sin verificar la firma del JWKS de Google (account takeover)',
      },
      {
        env: 'VEO_SMS_MODE',
        value: env.VEO_SMS_MODE,
        reason: 'el modo sandbox imprime el OTP en claro al log y NO lo envía (login roto + fuga de OTP)',
      },
      {
        env: 'VEO_EMAIL_MODE',
        value: env.VEO_EMAIL_MODE,
        reason: 'el modo sandbox solo loguea los correos de verificación y NO los envía',
      },
    ] as const;

    if (env.NODE_ENV === 'production') {
      for (const port of PRODUCTION_LIVE_PORTS) {
        if (port.value !== LIVE_MODE) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [port.env],
            message: `${port.env} debe ser "${LIVE_MODE}" en entornos productivos (NODE_ENV=production): ${port.reason}`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
