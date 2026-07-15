/**
 * Wiring del puerto de almacenamiento: adapter `live` (S3/MinIO self-hosted, forcePathStyle) o
 * `sandbox` (tests/dev). Selección por `VEO_STORAGE_MODE`.
 */
import { Readable } from 'node:stream';
import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ExternalServiceError, NotFoundError } from '@veo/utils';
import {
  STORAGE_PORT,
  type StoragePort,
  type PresignAudience,
  type PresignDownloadInput,
  type PresignUploadInput,
  type UploadObjectInput,
} from './storage.port';
import type { Env } from '../../config/env.schema';

/**
 * ¿El error del SDK de S3 significa "objeto no existe" (404)? GetObject sobre una key inexistente lanza
 * `NoSuchKey`; HeadObject lanza `NotFound`. Se narrowea `unknown` sin `any` (ESLint no-unsafe-*).
 */
function isS3NotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('name' in err && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return true;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 404;
}

interface S3Config {
  /**
   * Endpoint INTERNO (server-to-server): el host que ESTE servicio usa para hablar con MinIO/S3
   * (HeadObject/DeleteObject). En dev es `localhost:9002`; en prod, el endpoint interno del cluster.
   */
  endpoint: string;
  /**
   * Endpoint PÚBLICO (client-reachable por el DEVICE): el host que VERÁ la app del conductor/pasajero
   * (teléfono físico) que consume la URL prefirmada. SigV4 firma el `host` DENTRO de la firma, así que
   * la URL prefirmada DEBE generarse con un cliente cuyo endpoint sea este host — no se puede
   * intercambiar el host a posteriori sin romper la firma (SignatureDoesNotMatch). En dev es la IP LAN
   * del Mac (alcanzable desde el teléfono físico); en prod, el dominio público del bucket/CDN.
   */
  publicEndpoint: string;
  /**
   * Endpoint ADMIN (browser-reachable desde el MAC): el host que verá el operador en admin-web (vía
   * admin-bff) al consumir la URL prefirmada del visor. El browser corre en el propio Mac, así que el
   * host estable y siempre alcanzable es `localhost` — a diferencia de la IP LAN, no driftea con DHCP.
   */
  adminEndpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/**
 * Adapter LIVE: S3/MinIO real. forcePathStyle obligatorio para MinIO.
 *
 * TRES clientes por una razón de seguridad/correctitud, no de comodidad. SigV4 firma el `host` EN la
 * firma, así que el cliente debe nacer apuntando al host que el consumidor realmente alcanzará:
 *  - `internalClient` (endpoint = S3_ENDPOINT): operaciones server-to-server reales (HeadObject,
 *    DeleteObject). Las hace ESTE servicio, que alcanza MinIO por el host interno.
 *  - `devicePresignClient` (endpoint = S3_PUBLIC_BASE_URL): firma URLs que consume la app del
 *    conductor/pasajero (teléfono físico) → host LAN del Mac. Audiencia `'device'` (default).
 *  - `adminPresignClient` (endpoint = S3_ADMIN_BASE_URL): firma URLs que consume el operador en el
 *    browser DEL MAC (admin-web vía admin-bff) → `localhost` (estable, no driftea con DHCP).
 *    Audiencia `'admin'`.
 * Misma region/credenciales/forcePathStyle en los tres: lo único que cambia es el host.
 */
class S3LiveAdapter implements StoragePort {
  private readonly internalClient: S3Client;
  private readonly devicePresignClient: S3Client;
  private readonly adminPresignClient: S3Client;

  constructor(private readonly cfg: S3Config) {
    const shared = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    } as const;
    this.internalClient = new S3Client({ ...shared, endpoint: cfg.endpoint });
    this.devicePresignClient = new S3Client({ ...shared, endpoint: cfg.publicEndpoint });
    this.adminPresignClient = new S3Client({ ...shared, endpoint: cfg.adminEndpoint });
  }

  /** Elige el cliente de firma según QUIÉN consumirá la URL (default: device/LAN). */
  private presignClientFor(audience: PresignAudience | undefined): S3Client {
    return audience === 'admin' ? this.adminPresignClient : this.devicePresignClient;
  }

  async presignDownloadUrl(input: PresignDownloadInput): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: input.bucket ?? this.cfg.bucket,
      Key: input.key,
    });
    // Firma contra el host de la AUDIENCIA: la URL debe ser alcanzable por quien la consume.
    return getSignedUrl(this.presignClientFor(input.audience), command, {
      expiresIn: input.expiresSeconds,
    });
  }

  async presignUploadUrl(input: PresignUploadInput): Promise<string> {
    // El Content-Type queda firmado: el cliente DEBE enviar exactamente ese header en el PUT.
    const command = new PutObjectCommand({
      Bucket: input.bucket ?? this.cfg.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    // Firma contra el host de la AUDIENCIA: la URL debe ser alcanzable por quien la consume.
    return getSignedUrl(this.presignClientFor(input.audience), command, {
      expiresIn: input.expiresSeconds,
    });
  }

  async deleteObject(key: string, bucket?: string): Promise<void> {
    try {
      // Operación server-to-server: usa el host INTERNO.
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: bucket ?? this.cfg.bucket, Key: key }),
      );
    } catch (err) {
      throw new ExternalServiceError('No se pudo borrar el objeto en S3', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getObjectSize(key: string, bucket?: string): Promise<number> {
    try {
      // Operación server-to-server: usa el host INTERNO.
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: bucket ?? this.cfg.bucket, Key: key }),
      );
      return head.ContentLength ?? 0;
    } catch {
      return 0;
    }
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    // Operación server-to-server: usa el host INTERNO. Pagina ListObjectsV2 (máx 1000/página) y borra
    // en lotes con DeleteObjects (máx 1000/llamada) — el page-size de la lista ya cae dentro del límite.
    try {
      let deleted = 0;
      let continuationToken: string | undefined;
      do {
        const listed = await this.internalClient.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const objects = (listed.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => typeof k === 'string')
          .map((Key) => ({ Key }));
        if (objects.length > 0) {
          await this.internalClient.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
          );
          deleted += objects.length;
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);
      return deleted;
    } catch (err) {
      throw new ExternalServiceError('No se pudo borrar el prefijo en S3', {
        bucket,
        prefix,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getObjectStream(key: string, bucket?: string): Promise<Readable> {
    try {
      // Server-to-server (host INTERNO), NO presign: este servicio LEE los bytes para alimentar ffmpeg.
      // Los clientes de presign solo firman URLs; acá necesitamos el stream real, así que el cliente
      // INTERNO (el único que alcanza MinIO por el host interno y hace I/O de verdad).
      const res = await this.internalClient.send(
        new GetObjectCommand({ Bucket: bucket ?? this.cfg.bucket, Key: key }),
      );
      // En el runtime de Node, GetObject.Body es un `Readable` (http.IncomingMessage). Narrowing real
      // (instanceof), sin cast a `any`: descarta los tipos de browser (Blob/ReadableStream) del union.
      if (res.Body instanceof Readable) return res.Body;
      throw new NotFoundError('El objeto no entrega bytes legibles', { key });
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (isS3NotFound(err)) throw new NotFoundError('El objeto no existe en S3', { key });
      throw new ExternalServiceError('No se pudo leer el objeto de S3', {
        key,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async uploadObject(input: UploadObjectInput): Promise<void> {
    const Bucket = input.bucket ?? this.cfg.bucket;
    try {
      // Server-to-server (host INTERNO), NO presign: la subida la inicia ESTE servicio (la copia
      // derivada), no el cliente. Los clientes de presign firman URLs para terceros; acá subimos bytes.
      if (Buffer.isBuffer(input.body) || typeof input.contentLength === 'number') {
        // Largo conocido (Buffer, o stream con contentLength): un solo PutObject (más barato que multipart).
        await this.internalClient.send(
          new PutObjectCommand({
            Bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
            ContentLength: Buffer.isBuffer(input.body) ? input.body.length : input.contentLength,
          }),
        );
        return;
      }
      // Stream de largo DESCONOCIDO (pipe de ffmpeg): PutObject exigiría `Content-Length` por adelantado.
      // lib-storage `Upload` hace multipart y NO lo necesita — sube por chunks a medida que llegan.
      await new Upload({
        client: this.internalClient,
        params: { Bucket, Key: input.key, Body: input.body, ContentType: input.contentType },
      }).done();
    } catch (err) {
      throw new ExternalServiceError('No se pudo subir el objeto a S3', {
        key: input.key,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export { S3LiveAdapter };
export type { S3Config };

/** Junta todos los chunks de un `Readable` en un `Buffer` (sin `any`: el chunk del stream se tipa). */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/** Adapter SANDBOX: determinista, sin red. URLs estables + store en memoria para round-trips de tests. */
export class StorageSandboxAdapter implements StoragePort {
  private readonly logger = new Logger('StorageSandbox');
  /**
   * Store determinista en memoria (`bucket key` → bytes). Permite que `uploadObject`/`getObjectStream`
   * hagan round-trip REAL en tests (Lote 2/3 del watermark) sin levantar MinIO.
   */
  private readonly store = new Map<string, Buffer>();
  /** Bucket por defecto cuando el llamador no lo pasa (mismo sentinel que las URLs de presign). */
  private static readonly DEFAULT_BUCKET = 'sandbox';
  /** Tamaño por defecto (1 MiB) para keys NO subidas: preserva el happy path histórico de los tests. */
  private static readonly DEFAULT_SIZE_BYTES = 1_048_576;

  private storeKey(key: string, bucket?: string): string {
    return `${bucket ?? StorageSandboxAdapter.DEFAULT_BUCKET} ${key}`;
  }

  async presignDownloadUrl(input: PresignDownloadInput): Promise<string> {
    // URL determinista (sin red): incluye bucket, key y expiración para tests reproducibles.
    const bucket = input.bucket ?? 'sandbox';
    return `https://sandbox.s3.local/download/${bucket}/${input.key}?expires=${input.expiresSeconds}`;
  }

  async presignUploadUrl(input: PresignUploadInput): Promise<string> {
    // URL determinista (sin red): incluye bucket, key y expiración para tests reproducibles.
    const bucket = input.bucket ?? 'sandbox';
    return `https://sandbox.s3.local/upload/${bucket}/${input.key}?expires=${input.expiresSeconds}`;
  }

  async deleteObject(key: string, bucket?: string): Promise<void> {
    // Borra del store para que getObjectSize/getObjectStream queden HONESTOS tras un delete.
    this.store.delete(this.storeKey(key, bucket));
    this.logger.warn(`[SANDBOX] deleteObject ${bucket ?? 'default'}/${key}`);
  }

  async getObjectSize(key?: string, bucket?: string): Promise<number> {
    // Si la key fue subida, reflejá su tamaño REAL; si no, el default histórico (1 MiB) para no
    // romper el happy path de los tests que no suben bytes. `key` opcional: hay llamadores legacy
    // que invocan sin argumentos (retention.spec) y esperan el default.
    if (typeof key === 'string') {
      const bytes = this.store.get(this.storeKey(key, bucket));
      if (bytes) return bytes.length;
    }
    return StorageSandboxAdapter.DEFAULT_SIZE_BYTES;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    // Barre del store las keys del bucket bajo el prefijo (mantiene el sandbox internamente coherente).
    let deleted = 0;
    const scope = `${bucket} ${prefix}`;
    for (const storeKey of [...this.store.keys()]) {
      if (storeKey.startsWith(scope)) {
        this.store.delete(storeKey);
        deleted += 1;
      }
    }
    this.logger.warn(`[SANDBOX] deletePrefix ${bucket}/${prefix} (${deleted} borrados)`);
    return deleted;
  }

  async getObjectStream(key: string, bucket?: string): Promise<Readable> {
    const bytes = this.store.get(this.storeKey(key, bucket));
    if (!bytes) {
      // Honesto: una key inexistente lanza NotFoundError (igual que el adapter live), no un stream vacío.
      throw new NotFoundError('El objeto no existe en el sandbox de storage', { key });
    }
    return Readable.from(bytes);
  }

  async uploadObject(input: UploadObjectInput): Promise<void> {
    // Materializa el cuerpo a bytes y lo guarda: round-trip determinista por valor.
    const bytes = Buffer.isBuffer(input.body)
      ? Buffer.from(input.body)
      : await collectStream(input.body);
    this.store.set(this.storeKey(input.key, input.bucket), bytes);
  }
}

const storageProvider: Provider = {
  provide: STORAGE_PORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): StoragePort => {
    if (config.getOrThrow<string>('VEO_STORAGE_MODE') !== 'live') {
      return new StorageSandboxAdapter();
    }
    return new S3LiveAdapter({
      endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
      // Host LAN alcanzable por el DEVICE (teléfono): presign de la app del conductor/pasajero.
      publicEndpoint: config.getOrThrow<string>('S3_PUBLIC_BASE_URL'),
      // Host browser-reachable desde el MAC (localhost): presign del visor del operador (admin-bff).
      adminEndpoint: config.getOrThrow<string>('S3_ADMIN_BASE_URL'),
      region: config.getOrThrow<string>('S3_REGION'),
      accessKey: config.getOrThrow<string>('S3_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('S3_SECRET_KEY'),
      bucket: config.getOrThrow<string>('S3_BUCKET_VIDEO'),
      forcePathStyle: config.getOrThrow<boolean>('S3_FORCE_PATH_STYLE'),
    });
  },
};

@Module({ providers: [storageProvider], exports: [STORAGE_PORT] })
export class StorageModule {}
