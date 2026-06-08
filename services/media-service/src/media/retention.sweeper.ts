/**
 * RetentionSweeper — barrido del ciclo de vida de los videos (BR-S03).
 * Corre a diario: borra de S3/MinIO y de la base los segmentos cuya `retentionUntil` ya venció.
 * Nunca toca segmentos con retención indefinida (`retentionUntil = null`, viajes con pánico) hasta
 * que el pánico se resuelva (lo que recalcularía la retención).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../infra/prisma.service';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';

@Injectable()
export class RetentionSweeper {
  private readonly logger = new Logger(RetentionSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    const purged = await this.sweep();
    if (purged > 0) this.logger.log(`Retención: ${purged} segmento(s) purgado(s)`);
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
