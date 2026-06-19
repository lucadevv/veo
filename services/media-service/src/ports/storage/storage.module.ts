/**
 * Wiring del puerto de almacenamiento: adapter `live` (S3/MinIO self-hosted, forcePathStyle) o
 * `sandbox` (tests/dev). Selección por `VEO_STORAGE_MODE`.
 */
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
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ExternalServiceError } from '@veo/utils';
import {
  STORAGE_PORT,
  type StoragePort,
  type PresignAudience,
  type PresignDownloadInput,
  type PresignUploadInput,
} from './storage.port';
import type { Env } from '../../config/env.schema';

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
}

export { S3LiveAdapter };
export type { S3Config };

/** Adapter SANDBOX: determinista, sin red. URLs estables para tests. */
export class StorageSandboxAdapter implements StoragePort {
  private readonly logger = new Logger('StorageSandbox');

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
    this.logger.warn(`[SANDBOX] deleteObject ${bucket ?? 'default'}/${key}`);
  }

  async getObjectSize(): Promise<number> {
    // Tamaño determinista por debajo de cualquier cuota razonable (1 MiB) para el happy path de tests.
    return 1_048_576;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    // Sin red: el sandbox no mantiene objetos, así que el barrido es un no-op observable (log) y 0 borrados.
    this.logger.warn(`[SANDBOX] deletePrefix ${bucket}/${prefix}`);
    return 0;
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
