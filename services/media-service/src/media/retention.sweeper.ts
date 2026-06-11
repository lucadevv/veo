/**
 * RetentionSweeper — barrido del ciclo de vida de los videos (BR-S03).
 * Corre a diario: borra de S3/MinIO y de la base los segmentos cuya `retentionUntil` ya venció.
 * Nunca toca segmentos con retención indefinida (`retentionUntil = null`, viajes con pánico) hasta
 * que el pánico se resuelva (lo que recalcularía la retención).
 *
 * Lock distribuido en Redis (fix auditoría): en multi-réplica, dos barridos simultáneos chocan
 * (el segundo `delete` del mismo segmento tira P2025 a mitad del barrido). Solo una réplica corre.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { withDistributedLock } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';

const LOCK_KEY = 'veo:media:lock:retention-sweep';
/** Cota superior del barrido diario (mismo orden que los crons diarios de payment). */
const LOCK_TTL_SECONDS = 600;

@Injectable()
export class RetentionSweeper {
  private readonly logger = new Logger(RetentionSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    await withDistributedLock(this.redis, LOCK_KEY, LOCK_TTL_SECONDS, async () => {
      const purged = await this.sweep();
      if (purged > 0) this.logger.log(`Retención: ${purged} segmento(s) purgado(s)`);
    });
  }

  /** Devuelve cuántos segmentos se purgaron. Público para testeo/operación manual. */
  async sweep(now = new Date()): Promise<number> {
    const due = await this.prisma.read.mediaSegment.findMany({
      where: { retentionUntil: { not: null, lte: now } },
      select: { id: true, s3Key: true },
    });

    for (const seg of due) {
      await this.storage.deleteObject(seg.s3Key);
      await this.prisma.write.mediaSegment.delete({ where: { id: seg.id } });
    }
    return due.length;
  }
}
