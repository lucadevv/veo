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
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/** Adapter LIVE: S3/MinIO real. forcePathStyle obligatorio para MinIO. */
class S3LiveAdapter implements StoragePort {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  async presignDownloadUrl(input: PresignDownloadInput): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.cfg.bucket, Key: input.key });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresSeconds });
  }

  async presignUploadUrl(input: PresignUploadInput): Promise<string> {
    // El Content-Type queda firmado: el cliente DEBE enviar exactamente ese header en el PUT.
    const command = new PutObjectCommand({
      Bucket: input.bucket ?? this.cfg.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresSeconds });
  }

  async deleteObject(key: string, bucket?: string): Promise<void> {
    try {
      await this.client.send(
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
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket ?? this.cfg.bucket, Key: key }),
      );
      return head.ContentLength ?? 0;
    } catch {
      return 0;
    }
  }
}

/** Adapter SANDBOX: determinista, sin red. URLs estables para tests. */
export class StorageSandboxAdapter implements StoragePort {
  private readonly logger = new Logger('StorageSandbox');

  async presignDownloadUrl(input: PresignDownloadInput): Promise<string> {
    return `https://sandbox.s3.local/${input.key}?expires=${input.expiresSeconds}`;
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
