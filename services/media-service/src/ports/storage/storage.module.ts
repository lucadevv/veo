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
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ExternalServiceError } from '@veo/utils';
import {
  STORAGE_PORT,
  type StoragePort,
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
   * Endpoint PÚBLICO (client-reachable): el host que VERÁ el cliente que consume la URL prefirmada.
   * SigV4 firma el `host` DENTRO de la firma, así que la URL prefirmada DEBE generarse con un cliente
   * cuyo endpoint sea este host público — no se puede intercambiar el host a posteriori sin romper la
   * firma (SignatureDoesNotMatch). En dev es la IP LAN del Mac (alcanzable desde el teléfono físico);
   * en prod, el dominio público del bucket/CDN.
   */
  publicEndpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/**
 * Adapter LIVE: S3/MinIO real. forcePathStyle obligatorio para MinIO.
 *
 * DOS clientes por una razón de seguridad/correctitud, no de comodidad:
 *  - `internalClient` (endpoint = S3_ENDPOINT): operaciones server-to-server reales (HeadObject,
 *    DeleteObject). Las hace ESTE servicio, que alcanza MinIO por el host interno.
 *  - `presignClient` (endpoint = S3_PUBLIC_BASE_URL): SOLO para firmar URLs prefirmadas. El cliente
 *    final (app/teléfono) no alcanza el host interno, y como SigV4 firma el `host`, la URL debe
 *    nacer firmada contra el host público para ser a la vez alcanzable Y válida.
 * Misma region/credenciales/forcePathStyle en ambos: lo único que cambia es el host.
 */
class S3LiveAdapter implements StoragePort {
  private readonly internalClient: S3Client;
  private readonly presignClient: S3Client;

  constructor(private readonly cfg: S3Config) {
    const shared = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    } as const;
    this.internalClient = new S3Client({ ...shared, endpoint: cfg.endpoint });
    this.presignClient = new S3Client({ ...shared, endpoint: cfg.publicEndpoint });
  }

  async presignDownloadUrl(input: PresignDownloadInput): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: input.bucket ?? this.cfg.bucket,
      Key: input.key,
    });
    // Firma contra el host PÚBLICO: la URL debe ser alcanzable por el cliente final.
    return getSignedUrl(this.presignClient, command, { expiresIn: input.expiresSeconds });
  }

  async presignUploadUrl(input: PresignUploadInput): Promise<string> {
    // El Content-Type queda firmado: el cliente DEBE enviar exactamente ese header en el PUT.
    const command = new PutObjectCommand({
      Bucket: input.bucket ?? this.cfg.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    // Firma contra el host PÚBLICO: la URL debe ser alcanzable por el cliente final.
    return getSignedUrl(this.presignClient, command, { expiresIn: input.expiresSeconds });
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
      // Host público alcanzable por el cliente final: las URLs prefirmadas se firman contra él.
      publicEndpoint: config.getOrThrow<string>('S3_PUBLIC_BASE_URL'),
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
