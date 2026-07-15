/**
 * Validación de entorno (FOUNDATION §4). Si falta una var requerida, el servicio no arranca.
 * media-service: orquestación LiveKit self-hosted + grabaciones a S3/MinIO (BR-S01/S02/S03).
 */
import { z } from 'zod';
import { requiredInProd, secret, grpcTlsEnvSchema } from '@veo/utils';
import { outboxEnvSchema } from '@veo/database';

export const envSchema = z.object({
  // Transporte TLS de gRPC interno (ADR-016). Contrato compartido (FUENTE ÚNICA en @veo/utils): 3 rutas
  // OPCIONALES — ausentes = insecure (dev); presentes = mTLS. El valor lo lee grpcTlsPathsFromEnv() de process.env.
  ...grpcTlsEnvSchema.shape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3007),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Base de datos (read/write split)
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.string().url().optional(),

  // Redis (idempotencia de consumidores + locks de grabación)
  REDIS_URL: requiredInProd('redis://localhost:6379'),

  // Kafka (outbox relay + consumidores de dominio)
  KAFKA_BROKERS: requiredInProd('localhost:9094'),

  // Outbox relay (perillas tuneables sin redeploy). FUENTE ÚNICA: las 4 vars + sus defaults + el invariante
  // viven en `outboxEnvSchema` (@veo/database) — cero literales hand-copiados acá. El relay valida
  // OUTBOX_PUBLISH_TIMEOUT_MS < OUTBOX_CLAIM_STALE_MS (fail-fast anti double-publish por stale) en su ctor.
  ...outboxEnvSchema.shape,

  // Secreto para verificar la identidad interna que el BFF propaga (HMAC). También firma la identidad de
  // SISTEMA con la que el cliente de @veo/policy consulta el registro central (GET /internal/policies).
  INTERNAL_IDENTITY_SECRET: secret('dev-internal-secret-change-me'),

  // Base del API interno de identity-service (registro central de políticas PBAC · ADR-024 Fase 1). El
  // cliente de @veo/policy hace GET /internal/policies (firmado admin-rail) al boot para poblar su cache;
  // si es inalcanzable, cae al DEFAULT del catálogo (fail-safe, nunca tumba el arranque). Incluye /api/v1.
  IDENTITY_INTERNAL_URL: requiredInProd('http://localhost:3001/api/v1', { url: true }),

  // === LiveKit self-hosted (WebRTC). Sin SaaS: servidor propio. ===
  VEO_LIVEKIT_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  /// URL de señalización para clientes (ws://). Se usa como host http(s) para las APIs de servidor.
  /// Fail-fast en prod (igual que LIVEKIT_API_SECRET): media-service SIEMPRE usa LiveKit real en prod
  /// (el secret() de abajo ya lo exige), así que la URL no puede quedar en el localhost de dev → apuntaría
  /// a un server de señalización inexistente y la cámara en vivo (diferenciador core) se caería en silencio.
  LIVEKIT_URL: requiredInProd('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  // Secreto que FIRMA los tokens WebRTC de la cámara en vivo (seguridad core). Fail-fast en prod: no
  // arrancar con el secreto de dev (forjable → cualquiera mintea acceso a la cámara del habitáculo).
  LIVEKIT_API_SECRET: secret('devsecret_change_in_production'),
  /// TTL del token de cámara que se emite a passenger/driver.
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().default(3600),

  // === Almacenamiento de grabaciones: S3/MinIO self-hosted (forcePathStyle). ===
  VEO_STORAGE_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  S3_ENDPOINT: requiredInProd('http://localhost:9002'),
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
  /// Nombre de la clave maestra MinIO SSE-S3 bajo la que el video se cifra at-rest (envelope, §0.7c · Ley
  /// 29733). NO es AWS KMS: es el KMS interno de MinIO con nuestra clave (MINIO_KMS_SECRET_KEY, SOPS+age).
  /// El cifrado es SERVER-SIDE transparente; este nombre se persiste como metadato para auditar rotación.
  VIDEO_SSE_KEY_NAME: z.string().default('veo-media-key'),

  // === Retención (BR-S03) ===
  RETENTION_DEFAULT_DAYS: z.coerce.number().default(30),
  RETENTION_INCIDENT_DAYS: z.coerce.number().default(180),
  /// Validez de la URL firmada para visualizar video (BR-S02): 5 minutos.
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),

  // === Quemado (burn-in) de watermark en video (BR-S02 · ports&adapters). SIN secretos: ffmpeg no
  // maneja credenciales. El binario/SDK vive SOLO en `FfmpegWatermarkAdapter`. ===
  /// `sandbox` (default): passthrough determinista sin ffmpeg (tests). `live`: invoca el binario ffmpeg.
  VEO_WATERMARK_MODE: z.enum(['live', 'sandbox']).default('sandbox'),
  /// Ruta del binario ffmpeg (en el image va en el PATH del runtime alpine; en host puede ser absoluto).
  WATERMARK_FFMPEG_PATH: z.string().default('ffmpeg'),
  /// Ruta del TTF para drawtext. Default = la fuente del paquete alpine `ttf-dejavu`, que instala en
  /// `/usr/share/fonts/dejavu/` (NO en `/usr/share/fonts/ttf-dejavu/`). Verificado contra el paquete.
  WATERMARK_FONT_PATH: z.string().default('/usr/share/fonts/dejavu/DejaVuSans.ttf'),
  /// Altura máxima del derivado en px (downscale, nunca upscale): acota costo de re-encode y peso.
  WATERMARK_MAX_HEIGHT: z.coerce.number().int().positive().default(720),
  /// CRF de libx264 (calidad/compresión): 28 = balance razonable para evidencia.
  WATERMARK_CRF: z.coerce.number().int().default(28),
  /// Preset de libx264 (velocidad vs tamaño): `veryfast` prioriza throughput del render server-side.
  WATERMARK_PRESET: z.string().default('veryfast'),
  /// Timeout duro del render en ms: al excederlo se mata ffmpeg (SIGKILL) y se devuelve error tipado.
  WATERMARK_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  // === Worker de render (Lote 3 · quema lazy + reaper). Perillas tuneables sin redeploy. SIN secretos. ===
  /// Cada cuántos segundos corre el worker que quema watermark de las solicitudes PENDING (lazy + reaper).
  WATERMARK_RENDER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  /// Cuántas solicitudes rinde como máximo por tick (SECUENCIAL, para no fundir el CPU del VPS).
  WATERMARK_RENDER_BATCH: z.coerce.number().int().positive().default(3),
  /// Cap de intentos de render por solicitud: al alcanzarlo, streamAccess deja de reintentar y tira error.
  WATERMARK_RENDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /// Prefijo S3/MinIO de las copias derivadas (watermark quemado). Dedicado → barrido por prefijo seguro.
  WATERMARK_RENDERED_PREFIX: z.string().default('watermarked/'),
  /// TTL del lock distribuido del worker (s). DEBE superar el peor caso del batch (batch × render timeout).
  WATERMARK_RENDER_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /// Antigüedad (s) tras la cual un PROCESSING se considera COLGADO (worker murió a mitad) y se re-toma.
  /// DEBE superar el render timeout (un render en curso legítimo no debe verse como colgado).
  WATERMARK_RENDER_STALE_SECONDS: z.coerce.number().int().positive().default(600),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // gRPC (lectura síncrona desde otros servicios — veo.media.v1)
  GRPC_URL: z.string().default('0.0.0.0:50057'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
