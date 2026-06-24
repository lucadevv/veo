/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 */
import { z } from 'zod';
import { secret } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

/**
 * Modos de puerto intercambiable (enum tipado, fuente única — sin string mágico esparcido). `live` usa el
 * proveedor real/propio; `sandbox` usa un sustituto inseguro para dev/CI (loguea, no envía). El fail-fast de
 * entorno productivo (superRefine) compara contra `LIVE_MODE`, la constante tipada — nunca contra un literal
 * `'live'` esparcido. Local a este env.schema: cada servicio es una isla (decisión tomada, NO compartir).
 */
export const PORT_MODES = ['live', 'sandbox'] as const;
export const LIVE_MODE = 'live' satisfies (typeof PORT_MODES)[number];

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3011),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Base de datos (read/write split)
    DATABASE_URL: z.string().url(),
    DATABASE_URL_REPLICA: z.string().url().optional(),

    // Redis (OTP de contactos + cool-down de la lista + rate-limit)
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // Kafka (outbox relay + consumidores)
    KAFKA_BROKERS: z.string().default('localhost:9094'),
    // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
    // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
    // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
    ...outboxEnvSchema.shape,
    KAFKA_CONSUMER_GROUP: z.string().default('share-service'),

    // Secreto para firmar los enlaces de seguimiento (HMAC). KMS/Secrets Manager en prod.
    SHARE_LINK_SECRET: secret('dev-share-link-secret-change-me'),
    // TTL del enlace de seguimiento (por defecto 2h tras crearlo, configurable).
    SHARE_LINK_TTL_SECONDS: z.coerce.number().default(7_200),
    // Usos máximos por defecto de un enlace (la página familia se refresca varias veces).
    SHARE_LINK_MAX_USES: z.coerce.number().default(500),
    // Base pública para construir la URL del enlace que se envía por SMS.
    SHARE_PUBLIC_BASE_URL: z.string().default('http://localhost:3011/api/v1/public/share'),

    // Contactos de confianza (BR-I06)
    MAX_TRUSTED_CONTACTS: z.coerce.number().default(3),
    // Cool-down para modificar la lista de contactos (24h por defecto).
    CONTACT_MODIFY_COOLDOWN_HOURS: z.coerce.number().default(24),

    // OTP de verificación del contacto
    OTP_TTL_SECONDS: z.coerce.number().default(300), // 5 min
    OTP_MAX_ATTEMPTS: z.coerce.number().default(3),

    // Puerto SMS (modo propio/sandbox por defecto)
    VEO_SMS_MODE: z.enum(PORT_MODES).default('sandbox'),

    // notification-service (modo SMS live): el adaptador delega la entrega del OTP por REST FIRMADO
    // (POST /notifications). Mismas vars que identity-service. URL apunta a la API interna (/api/v1).
    NOTIFICATION_INTERNAL_URL: z.string().url().default('http://localhost:3008/api/v1'),
    NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

    // Secreto de identidad interna que el BFF propaga a los servicios
    INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // gRPC (lectura síncrona desde otros servicios: notification/panic)
    GRPC_URL: z.string().default('0.0.0.0:50061'),
  })
  .superRefine((env, ctx) => {
    // FAIL-FAST DE SEGURIDAD (regla ENTORNOS · diferenciador VEO): en un entorno PRODUCTIVO (internet-facing)
    // TODOS los puertos intercambiables DEBEN estar en `live`. `NODE_ENV=production` es la señal canónica de
    // "entorno endurecido" del repo (cubre preview Y prod, ver @veo/utils isHardenedEnv) — el MISMO criterio
    // que `secret()` usa para rechazar secretos de dev. En `sandbox` el sender SMS NO envía nada real: solo
    // loguea el destino enmascarado. En producción eso rompe seguridad Y funcionalidad. En local/development
    // `sandbox` SIGUE permitido (no rompe el dev/CI sin gateway de operador). DRY + sin string mágico: un solo
    // loop sobre la tabla de puertos, comparando contra `LIVE_MODE` (la constante tipada) — nunca contra `'live'`.
    const PRODUCTION_LIVE_PORTS = [
      {
        env: 'VEO_SMS_MODE',
        value: env.VEO_SMS_MODE,
        reason:
          'el modo sandbox NO envía el SMS (solo loguea) → ni el OTP de verificación del contacto ni el enlace de seguimiento que se manda al familiar en pánico llegan nunca',
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
