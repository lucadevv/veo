/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 * media-service: orquestación LiveKit self-hosted + grabaciones a S3/MinIO (BR-S01/S02/S03).
 */
import { z } from 'zod';
import { secret } from '@veo/utils';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3007),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (idempotencia de consumidores + locks de grabación)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores de dominio)
  KAFKA_BROKERS: z.string().default('localhost:9094'),

  // Secreto para verificar la identidad interna que el BFF propaga (HMAC)
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // === LiveKit self-hosted (WebRTC). Sin SaaS: servidor propio. ===
  VEO_LIVEKIT_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  /// URL de señalización para clientes (ws://). Se usa como host http(s) para las APIs de servidor.
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  // Secreto que FIRMA los tokens WebRTC de la cámara en vivo (seguridad core). Fail-fast en prod: no
  // arrancar con el secreto de dev (forjable → cualquiera mintea acceso a la cámara del habitáculo).
  LIVEKIT_API_SECRET: secret('devsecret_change_in_production'),
  /// TTL del token de cámara que se emite a passenger/driver.
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().default(3600),

  // === Almacenamiento de grabaciones: S3/MinIO self-hosted (forcePathStyle). ===
  VEO_STORAGE_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  S3_ENDPOINT: z.string().default('http://localhost:9002'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('veo_dev'),
  // Credencial del storage soberano de VIDEO (Ley 29733). Fail-fast en prod: el video del habitáculo no
  // puede guardarse con credenciales de dev conocidas.
  S3_SECRET_KEY: secret('veo_dev_secret'),
  S3_BUCKET_VIDEO: z.string().default('veo-video-dev'),
  /// Bucket de avatares del pasajero/conductor. LECTURA PÚBLICA: la publicUrl es accesible sin firma.
  S3_BUCKET_AVATAR: z.string().default('veo-avatars-dev'),
  /// Bucket de documentos de flota (certificados, licencias). PRIVADO: solo accesible vía URL firmada.
  S3_BUCKET_DOCUMENTS: z.string().default('veo-documents-dev'),
  /// Base pública (DEVICE/LAN) para firmar el presign de la app del conductor/pasajero (teléfono) y
  /// componer la URL estable del avatar (path-style, coherente con MinIO/forcePathStyle). En dev es la
  /// IP LAN del Mac, alcanzable desde el teléfono físico.
  S3_PUBLIC_BASE_URL: z.string().default('http://localhost:9002'),
  /// Base ADMIN (browser del MAC) para firmar el presign-GET del visor del operador (admin-bff). El
  /// browser corre en el propio Mac → `localhost` es estable y siempre alcanzable (no driftea con DHCP
  /// como la IP LAN). Solo aplica a las URLs de audiencia `'admin'`; el device sigue usando la LAN.
  S3_ADMIN_BASE_URL: z.string().default('http://localhost:9002'),
  /// Tamaño máximo permitido para el avatar, en bytes (BR: el presign no acota el body, se valida en
  /// el `confirm` tras la subida con HeadObject; si excede se borra y se rechaza). Default 5 MiB.
  AVATAR_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === 'string' ? v === 'true' : v)),
  /// Referencia a la clave KMS con la que se cifra el video en reposo (SSE-KMS en prod).
  KMS_KEY_ID_VIDEO: z.string().default('alias/veo-video'),

  // === Retención (BR-S03) ===
  RETENTION_DEFAULT_DAYS: z.coerce.number().default(30),
  RETENTION_INCIDENT_DAYS: z.coerce.number().default(180),
  /// Validez de la URL firmada para visualizar video (BR-S02): 5 minutos.
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios — veo.media.v1)
  GRPC_URL: z.string().default('0.0.0.0:50057'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
