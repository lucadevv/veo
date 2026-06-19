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
/** Tamaño de página del barrido por keyset (mismo patrón que ExpirySweeper de fleet-service). */
const PAGE_SIZE = 500;

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

  /**
   * Devuelve cuántos segmentos se purgaron. Público para testeo/operación manual.
   *
   * Barrido por keyset (id asc, página de PAGE_SIZE) para no cargar todos los vencidos en memoria.
   * Por página, en DOS fases con ORDEN deliberado:
   *  1) S3 primero, objeto por objeto (el port no tiene batch delete de keys arbitrarias y las keys NO
   *     comparten prefijo → deletePrefix no sirve). `deleteObject` es idempotente, así que un fallo se
   *     reintenta sano el próximo tick. Un objeto que falla NO entra a `deletable` y NO aborta el lote.
   *  2) DB después, en UN solo `deleteMany` de los ids cuyo objeto S3 ya se borró. Nunca se borra la
   *     fila DB de un objeto que sigue vivo en S3 (de ahí el orden: S3 → DB).
   */
  async sweep(now = new Date()): Promise<number> {
    let purged = 0;
    let cursorId: string | undefined;
    for (;;) {
      const due = await this.prisma.read.mediaSegment.findMany({
        where: { retentionUntil: { not: null, lte: now } },
        select: { id: true, s3Key: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (due.length === 0) break;
      cursorId = due[due.length - 1]?.id;

      // Fase 1 — S3 por objeto: solo los borrados OK se marcan para purgar de DB.
      const deletable: string[] = [];
      for (const seg of due) {
        try {
          await this.storage.deleteObject(seg.s3Key);
          deletable.push(seg.id);
        } catch (err) {
          this.logger.warn(
            { err, segmentId: seg.id, s3Key: seg.s3Key },
            'fallo al borrar objeto S3 de retención; se reintenta el próximo barrido',
          );
        }
      }

      // Fase 2 — DB en batch: una sola escritura por página para los objetos ya borrados de S3.
      if (deletable.length > 0) {
        await this.prisma.write.mediaSegment.deleteMany({ where: { id: { in: deletable } } });
        purged += deletable.length;
      }

      if (due.length < PAGE_SIZE) break;
    }
    return purged;
  }
}
