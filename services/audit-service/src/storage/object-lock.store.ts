/**
 * Réplica inmutable WORM del audit log a S3 (MinIO self-hosted en dev).
 * Usa S3 Object Lock en modo COMPLIANCE: ni el root puede borrar/sobrescribir un objeto
 * antes de que venza la retención → garantía real de no-manipulación a nivel de storage.
 *
 * El bucket DEBE crearse con Object Lock habilitado (solo se puede activar al crearlo,
 * lo que requiere versioning). `ensureBucket` lo crea si no existe.
 */
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  PutObjectLockConfigurationCommand,
  ObjectLockRetentionMode,
  ObjectLockEnabled,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { ExternalServiceError } from '@veo/utils';

/** Puerto de almacenamiento inmutable (DIP: el servicio depende de esta abstracción). */
export interface ImmutableObjectStore {
  ensureBucket(): Promise<void>;
  /** Escribe un objeto WORM con retención. Idempotente por clave determinista. */
  putImmutable(key: string, body: string): Promise<void>;
  /** Lee un objeto (verificación/auditoría externa). */
  getObject(key: string): Promise<string>;
  healthy(): Promise<boolean>;
}

export interface ObjectLockStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  retentionDays: number;
}

export class S3ObjectLockStore implements ImmutableObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly retentionDays: number;

  constructor(config: ObjectLockStoreConfig) {
    this.bucket = config.bucket;
    this.retentionDays = config.retentionDays;
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    };
    this.client = new S3Client(clientConfig);
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // No existe (o sin permiso de HEAD) → intentar crearlo con Object Lock.
    }
    try {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.bucket, ObjectLockEnabledForBucket: true }),
      );
      // Configura retención por defecto del bucket (defensa adicional).
      await this.client.send(
        new PutObjectLockConfigurationCommand({
          Bucket: this.bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: ObjectLockEnabled.Enabled,
            Rule: {
              DefaultRetention: {
                Mode: ObjectLockRetentionMode.COMPLIANCE,
                Days: this.retentionDays,
              },
            },
          },
        }),
      );
    } catch (err) {
      throw new ExternalServiceError('No se pudo asegurar el bucket WORM de auditoría', {
        bucket: this.bucket,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async putImmutable(key: string, body: string): Promise<void> {
    const retainUntil = new Date(Date.now() + this.retentionDays * 24 * 60 * 60 * 1000);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ObjectLockMode: ObjectLockRetentionMode.COMPLIANCE,
          ObjectLockRetainUntilDate: retainUntil,
        }),
      );
    } catch (err) {
      throw new ExternalServiceError('Falló la réplica WORM a S3', {
        bucket: this.bucket,
        key,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getObject(key: string): Promise<string> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = res.Body;
      if (!body) throw new Error('cuerpo vacío');
      return await body.transformToString('utf-8');
    } catch (err) {
      throw new ExternalServiceError('No se pudo leer el objeto WORM', {
        bucket: this.bucket,
        key,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** Clave determinista de un objeto de auditoría: ordenable por seq + hash para integridad. */
export function auditObjectKey(seq: bigint | number, hash: string): string {
  const padded = String(seq).padStart(20, '0');
  return `audit/${padded}-${hash}.json`;
}
