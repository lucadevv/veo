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
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { withDistributedLock } from '@veo/utils';
import { MEDIA_REPO, type MediaRepository } from './media.repository';
import { REDIS } from '../infra/redis';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import { renderedKeyFor } from './watermark';
import type { Env } from '../config/env.schema';

const LOCK_KEY = 'veo:media:lock:retention-sweep';
/** Cota superior del barrido diario (mismo orden que los crons diarios de payment). */
const LOCK_TTL_SECONDS = 600;
/** Tamaño de página del barrido por keyset (mismo patrón que ExpirySweeper de fleet-service). */
const PAGE_SIZE = 500;

@Injectable()
export class RetentionSweeper {
  private readonly logger = new Logger(RetentionSweeper.name);
  private readonly renderedPrefix: string;

  constructor(
    @Inject(MEDIA_REPO) private readonly repo: MediaRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.renderedPrefix = config.getOrThrow<string>('WATERMARK_RENDERED_PREFIX');
  }

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
    // Viajes cuyos segmentos crudos se purgaron en este barrido. Tras el loop se revisa cuáles quedaron SIN
    // segmentos vivos para purgar las copias derivadas de sus solicitudes TRIP-LEVEL (segmentId=null) — ver
    // purgeDrainedTripCopies. Set para deduplicar (varios segmentos del mismo viaje en una o varias páginas).
    const affectedTripIds = new Set<string>();
    for (;;) {
      const due = await this.repo.findDueSegmentsPage(now, PAGE_SIZE, cursorId);
      if (due.length === 0) break;
      cursorId = due[due.length - 1]?.id;

      // Fase 1 — S3 por objeto: solo los borrados OK se marcan para purgar de DB.
      const deletable: string[] = [];
      for (const seg of due) {
        try {
          await this.storage.deleteObject(seg.s3Key);
          deletable.push(seg.id);
          if (seg.tripId) affectedTripIds.add(seg.tripId);
        } catch (err) {
          this.logger.warn(
            { err, segmentId: seg.id, s3Key: seg.s3Key },
            'fallo al borrar objeto S3 de retención; se reintenta el próximo barrido',
          );
        }
      }

      // Fase 1.5 — copias DERIVADAS de solicitudes SEGMENT-LEVEL (watermark quemado, Lote 3): video de cabina
      // con PII → se purgan junto al crudo (Ley 29733). Para cada segmento borrado OK, borra las copias de las
      // solicitudes que apuntan a ESE segmento por su clave COMPUTADA (`renderedKeyFor`), SIN filtrar por
      // `renderedS3Key`: así cae también la copia HUÉRFANA de un render que subió los bytes pero cuya tx de
      // READY falló (`renderedS3Key` quedó null). Cubre el caso en que el SEGMENTO muere pero el VIAJE sobrevive
      // (otros segmentos vivos): la copia de la solicitud de ese segmento concreto NO puede sobrevivir a su
      // fuente. Las solicitudes TRIP-LEVEL (segmentId=null) las cierra purgeDrainedTripCopies tras el loop.
      // Fail-tolerant como el resto (un fallo se reintenta el próximo barrido; no aborta el lote).
      if (deletable.length > 0) {
        const requests = await this.repo.listAccessRequestIdsBySegments(deletable);
        for (const r of requests) {
          await this.purgeRenderedCopy(r.id);
        }
      }

      // Fase 2 — DB en batch: una sola escritura por página para los objetos ya borrados de S3.
      if (deletable.length > 0) {
        await this.repo.deleteSegments(deletable);
        purged += deletable.length;
      }

      if (due.length < PAGE_SIZE) break;
    }

    // Fase 3 — copias DERIVADAS de solicitudes TRIP-LEVEL (segmentId=null) de viajes que quedaron SIN video.
    await this.purgeDrainedTripCopies(affectedTripIds);
    return purged;
  }

  /**
   * CAUSA RAÍZ (gap de retención): un `videoAccessRequest` con `segmentId=null` (acceso pedido por viaje, no por
   * segmento concreto) NUNCA matchea el filtro `segmentId IN (deletable)` de la Fase 1.5 → su copia derivada
   * (video de cabina + identidad del operador quemada) SOBREVIVÍA la retención normal INDEFINIDAMENTE. La copia
   * derivada NO puede sobrevivir a su video fuente: cuando un viaje queda SIN segmentos (todos barridos), las
   * copias de TODAS sus solicitudes (incluidas las trip-level) deben morir (Ley 29733).
   *
   * Conservador y correcto: solo purga copias de viajes DRENADOS (`count(mediaSegment where tripId)==0`). Un
   * viaje con segmentos vivos conserva sus copias (el operador puede re-ver el video al día siguiente — el render
   * trip-level resuelve "el último segmento del viaje", que sigue existiendo). Idempotente (`deleteObject` no-op)
   * y fail-tolerant (un fallo se reintenta el próximo barrido; no aborta el resto).
   */
  private async purgeDrainedTripCopies(tripIds: ReadonlySet<string>): Promise<void> {
    if (tripIds.size === 0) return; // ningún viaje afectado en este barrido → ninguna query.
    const candidateTripIds = [...tripIds];

    // Query 1 — UNA sola: qué viajes del set TODAVÍA tienen segmentos vivos (agrupados, no count por viaje).
    // groupBy colapsa el N+1 de `count` por tripId en una única lectura. Los que NO aparecen quedaron drenados.
    const aliveTripIds = new Set(await this.repo.findTripIdsWithLiveSegments(candidateTripIds));
    const drainedTripIds = candidateTripIds.filter((tripId) => !aliveTripIds.has(tripId));
    if (drainedTripIds.length === 0) return; // todos conservan video → sus copias siguen vigentes.

    // Query 2 — UNA sola: TODAS las solicitudes de los viajes drenados (incluidas las trip-level, segmentId=null).
    const requests = await this.repo.listAccessRequestIdsByTrips(drainedTripIds);
    for (const r of requests) {
      await this.purgeRenderedCopy(r.id);
    }
  }

  /**
   * Borra la copia derivada (watermark quemado) de UNA solicitud por su clave COMPUTADA (`renderedKeyFor`, no por
   * el campo DB `renderedS3Key` → cae también la copia huérfana). Idempotente y fail-tolerant: un fallo se loguea
   * y se reintenta el próximo barrido sin abortar el lote.
   */
  private async purgeRenderedCopy(requestId: string): Promise<void> {
    const renderedKey = renderedKeyFor(this.renderedPrefix, requestId);
    try {
      await this.storage.deleteObject(renderedKey);
    } catch (err) {
      this.logger.warn(
        { err, renderedKey },
        'fallo al borrar copia con watermark; se reintenta el próximo barrido',
      );
    }
  }
}
