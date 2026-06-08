import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';
import { uuidv7 } from '@veo/utils';
import { S3_EVIDENCE_STORE, type S3EvidenceStore } from './s3-evidence.port';
import type { Env } from '../../config/env.schema';

/** Ruta determinista/ordenable de un objeto de evidencia. */
function buildKeys(panicId: string, count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < Math.max(1, count); i += 1) {
    keys.push(`panic/${panicId}/evidence/${uuidv7()}.bin`);
  }
  return keys;
}

interface LiveOptions {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  retentionDays: number;
}

/**
 * Live: almacén compatible S3 (MinIO en dev) con Object Lock. forcePathStyle para MinIO.
 * El bucket se crea con ObjectLockEnabledForBucket → habilita retención WORM por objeto.
 */
class LiveS3EvidenceStore implements S3EvidenceStore {
  private readonly logger = new Logger('S3EvidenceLive');
  private readonly client: S3Client;

  constructor(private readonly opts: LiveOptions) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    });
  }

  reserveKeys(panicId: string, count: number): string[] {
    return buildKeys(panicId, count);
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
      return;
    } catch {
      // No existe (o sin permiso de head): intentamos crearlo con Object Lock.
    }
    try {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.opts.bucket, ObjectLockEnabledForBucket: true }),
      );
      this.logger.log(`Bucket de evidencia creado con Object Lock: ${this.opts.bucket}`);
    } catch (err) {
      // Carrera (otro proceso lo creó) u otro fallo: no debe tumbar el arranque del servicio.
      this.logger.warn({ err }, `No se pudo asegurar el bucket ${this.opts.bucket}`);
    }
  }

  async protect(keys: string[]): Promise<string[]> {
    const retainUntilDate = new Date(Date.now() + this.opts.retentionDays * 24 * 60 * 60 * 1000);
    const protectedKeys: string[] = [];
    for (const key of keys) {
      try {
        await this.client.send(
          new PutObjectRetentionCommand({
            Bucket: this.opts.bucket,
            Key: key,
            Retention: { Mode: 'COMPLIANCE', RetainUntilDate: retainUntilDate },
          }),
        );
        protectedKeys.push(key);
      } catch (err) {
        // El objeto puede no haberse subido aún por media-service: se reintenta al re-anexar.
        this.logger.warn({ err, key }, 'No se pudo aplicar retención WORM (objeto inexistente?)');
      }
    }
    return protectedKeys;
  }
}

/** Sandbox: reserva keys sin tocar red (tests/CI offline). No aplica retención real. */
class SandboxS3EvidenceStore implements S3EvidenceStore {
  private readonly logger = new Logger('S3EvidenceSandbox');
  reserveKeys(panicId: string, count: number): string[] {
    return buildKeys(panicId, count);
  }
  async ensureBucket(): Promise<void> {
    this.logger.warn('[SANDBOX] ensureBucket no-op (Object Lock deshabilitado en sandbox)');
  }
  async protect(keys: string[]): Promise<string[]> {
    this.logger.warn(`[SANDBOX] protect no-op para ${keys.length} keys`);
    return keys;
  }
}

const evidenceProvider: Provider = {
  provide: S3_EVIDENCE_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): S3EvidenceStore =>
    config.getOrThrow<string>('VEO_EVIDENCE_MODE') === 'live'
      ? new LiveS3EvidenceStore({
          endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
          region: config.getOrThrow<string>('S3_REGION'),
          accessKey: config.getOrThrow<string>('S3_ACCESS_KEY'),
          secretKey: config.getOrThrow<string>('S3_SECRET_KEY'),
          bucket: config.getOrThrow<string>('S3_BUCKET_EVIDENCE'),
          retentionDays: config.getOrThrow<number>('EVIDENCE_RETENTION_DAYS'),
        })
      : new SandboxS3EvidenceStore(),
};

@Module({ providers: [evidenceProvider], exports: [S3_EVIDENCE_STORE] })
export class S3EvidenceModule {}
