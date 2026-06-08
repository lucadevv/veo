/**
 * S3ReplicationRelay — replica las entradas del audit log a S3/MinIO con Object Lock (WORM).
 * Patrón outbox: toma entradas con s3ObjectKey=null, escribe el objeto inmutable y estampa
 * la clave (write-once permitido por los triggers append-only). Resiliente: si S3 está caído,
 * reintenta en el siguiente tick sin perder entradas ni bloquear el append.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditRepository } from '../audit/audit.repository';
import { AUDIT_OBJECT_STORE } from './storage.module';
import { auditObjectKey, type ImmutableObjectStore } from './object-lock.store';
import type { Env } from '../config/env.schema';

@Injectable()
export class S3ReplicationRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(S3ReplicationRelay.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private bucketReady = false;

  constructor(
    @Inject(AUDIT_OBJECT_STORE) private readonly store: ImmutableObjectStore | null,
    private readonly repo: AuditRepository,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('AUDIT_S3_RELAY_INTERVAL_MS');
  }

  async onModuleInit(): Promise<void> {
    if (!this.store) {
      this.logger.warn('Réplica WORM a S3 DESACTIVADA (AUDIT_S3_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running || !this.store) return;
    this.running = true;
    try {
      if (!this.bucketReady) {
        await this.store.ensureBucket();
        this.bucketReady = true;
      }
      const pending = await this.repo.findUnreplicated(100);
      for (const entry of pending) {
        const key = auditObjectKey(entry.seq, entry.hash);
        const body = JSON.stringify({
          id: entry.id,
          seq: String(entry.seq),
          eventId: entry.eventId,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          ip: entry.ip,
          userAgent: entry.userAgent,
          occurredAt: entry.occurredAt.toISOString(),
          payload: entry.payload,
          prevHash: entry.prevHash,
          hash: entry.hash,
          createdAt: entry.createdAt.toISOString(),
        });
        await this.store.putImmutable(key, body);
        await this.repo.stampS3Key(entry.id, key);
      }
      if (pending.length > 0) this.logger.debug(`WORM: replicadas ${pending.length} entradas a S3`);
    } catch (err) {
      this.bucketReady = false;
      this.logger.error({ err }, 'réplica WORM a S3 falló (se reintentará)');
    } finally {
      this.running = false;
    }
  }
}
