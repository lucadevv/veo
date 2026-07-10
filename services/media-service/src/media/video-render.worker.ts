/**
 * VideoRenderWorker — QUEMADO (burn-in) server-side del watermark (BR-S02 · Lote 3 · EL CORAZÓN).
 *
 * PORQUÉ existe: `streamAccess` NUNCA debe presignar el video CRUDO al operador (sería descargable y
 * filtrable sin rastro). En su lugar firma una COPIA DERIVADA con un watermark por-acceso (operador ·
 * requestId · timestamp) QUEMADO en cada frame. Ese quemado es caro (re-encode con ffmpeg) → se hace
 * ASÍNCRONO en este worker: `streamAccess` marca el render PENDING y devuelve PROCESSING; el worker rinde
 * y deja la copia READY; el próximo `streamAccess` la sirve.
 *
 * Espejo del `RetentionSweeper`: corre periódicamente bajo un LOCK DISTRIBUIDO (solo una réplica rinde a la
 * vez) y procesa un batch acotado SECUENCIAL (no funde el CPU del VPS). Doble función:
 *  1. quema las solicitudes `renderStatus=PENDING` (lazy, disparadas por `streamAccess`);
 *  2. REAPER: re-toma las `PROCESSING` COLGADAS (un worker murió a mitad → `renderRequestedAt` viejo).
 *
 * IDEMPOTENCIA (sin doble-render): cada solicitud se TOMA con un UPDATE condicional atómico
 * (`PENDING` o `PROCESSING-colgado` → `PROCESSING`, attempts++). Si otra réplica la tomó primero, el UPDATE
 * no afecta filas y se SALTA. ATOMICIDAD estado↔evento: el resultado (READY/FAILED) y su evento de outbox
 * van en la MISMA `$transaction` (como recording.service).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { NotFoundError, withDistributedLock } from '@veo/utils';
import type Redis from 'ioredis';
import { MEDIA_REPO, type MediaRepository, type RenderTarget } from './media.repository';
import { REDIS } from '../infra/redis';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import {
  VIDEO_WATERMARK_PORT,
  type VideoWatermarkPort,
} from '../ports/watermark/video-watermark.port';
import { buildWatermark, renderedKeyFor } from './watermark';
import { VideoRenderStatus } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const PRODUCER = 'media-service';
/** Lock distribuido del worker (solo una réplica rinde a la vez — espejo del RetentionSweeper). */
const LOCK_KEY = 'media:render:worker';
/** Nombre del interval registrado en el SchedulerRegistry (cleanup en onModuleDestroy). */
const INTERVAL_NAME = 'media-render-worker';
/** Cota de longitud de `renderError` (técnico, SIN PII): truncado defensivo. */
const RENDER_ERROR_MAX = 500;

@Injectable()
export class VideoRenderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRenderWorker.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly renderedPrefix: string;
  private readonly lockTtlSeconds: number;
  private readonly staleMs: number;

  constructor(
    @Inject(MEDIA_REPO) private readonly repo: MediaRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(VIDEO_WATERMARK_PORT) private readonly watermark: VideoWatermarkPort,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('WATERMARK_RENDER_INTERVAL_SECONDS') * 1000;
    this.batchSize = config.getOrThrow<number>('WATERMARK_RENDER_BATCH');
    this.maxAttempts = config.getOrThrow<number>('WATERMARK_RENDER_MAX_ATTEMPTS');
    this.renderedPrefix = config.getOrThrow<string>('WATERMARK_RENDERED_PREFIX');
    this.lockTtlSeconds = config.getOrThrow<number>('WATERMARK_RENDER_LOCK_TTL_SECONDS');
    this.staleMs = config.getOrThrow<number>('WATERMARK_RENDER_STALE_SECONDS') * 1000;
  }

  /**
   * Registra el tick periódico. Se usa SchedulerRegistry + setInterval (en vez de `@Cron`) para honrar el
   * intervalo EXACTO del env (`@Cron` fija la expresión en tiempo de decoración, no puede leer ConfigService);
   * el patrón de fondo (lock distribuido + batch) es idéntico al RetentionSweeper.
   */
  onModuleInit(): void {
    const handle = setInterval(() => {
      void this.run();
    }, this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Tick: corre el batch bajo el lock distribuido (solo una réplica). Espejo de RetentionSweeper.run(). */
  async run(): Promise<void> {
    await withDistributedLock(this.redis, LOCK_KEY, this.lockTtlSeconds, async () => {
      const rendered = await this.processBatch();
      if (rendered > 0) this.logger.log(`Render: ${rendered} solicitud(es) procesada(s) este tick`);
    });
  }

  /**
   * Procesa un batch (público para testeo/operación manual, SIN lock — el lock vive en run()).
   * 1) REAPER terminal: marca FAILED las PROCESSING colgadas que YA agotaron los intentos (no loop infinito).
   * 2) toma hasta `batchSize` solicitudes PENDING o PROCESSING-colgadas (con intentos disponibles), ordenadas
   *    por `renderRequestedAt asc`, y las rinde SECUENCIAL. Devuelve cuántas se procesaron (READY o FAILED).
   */
  async processBatch(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - this.staleMs);

    // 1) REAPER terminal: una PROCESSING colgada que ya gastó todos los intentos no se re-toma → marcala
    // FAILED para que streamAccess corte el loop (FAILED ≥ cap → error tipado). Janitorial: sin evento.
    await this.repo.reapStaleRenders(staleBefore, this.maxAttempts);

    // 2) batch de candidatas: PENDING, o PROCESSING colgada (worker muerto), siempre con intentos disponibles.
    const candidates = await this.repo.findRenderCandidates(
      staleBefore,
      this.maxAttempts,
      this.batchSize,
    );

    let processed = 0;
    for (const target of candidates) {
      // GUARD atómico anti-doble-toma: solo procede si ESTA réplica logra moverla a PROCESSING (attempts++).
      const claimed = await this.repo.claimRenderTarget(
        target.id,
        staleBefore,
        this.maxAttempts,
        now,
      );
      if (claimed === 0) continue; // otra réplica la tomó → saltar.

      await this.renderOne(target, now);
      processed += 1;
    }
    return processed;
  }

  /**
   * Rinde UNA solicitud ya tomada (PROCESSING). Pipeline ports&adapters:
   *   getObjectStream(crudo) → watermark.burn(text) → uploadObject(copia derivada).
   * El `output` del puerto de watermark DEBE consumirse (se pipea directo a uploadObject — contrato de
   * ownership). Éxito → READY + evento `media.render_completed`; falla → FAILED + `media.render_failed`
   * (estado↔evento atómicos en una sola $transaction). NUNCA re-tira: sigue con el resto del batch.
   */
  private async renderOne(target: RenderTarget, now: Date): Promise<void> {
    const renderedKey = renderedKeyFor(this.renderedPrefix, target.id);
    try {
      const segment = await this.resolveSegment(target.segmentId, target.tripId);
      const text = buildWatermark({
        operatorEmail: target.requestedByEmail,
        requestId: target.id,
        at: now,
      });
      const source = await this.storage.getObjectStream(segment.s3Key);
      const { output, contentType } = await this.watermark.burn({ source, text });
      // Consumir el output es OBLIGATORIO (libera temp-files del adapter): se pipea directo a la subida.
      await this.storage.uploadObject({ key: renderedKey, body: output, contentType });

      await this.repo.runInTx(async (tx) => {
        await tx.videoAccessRequest.update({
          where: { id: target.id },
          data: {
            renderStatus: VideoRenderStatus.READY,
            renderedS3Key: renderedKey,
            renderedAt: now,
            renderError: null,
            // Persiste el watermark QUEMADO (lo devuelve streamAccess READY como info para el cliente).
            watermark: text,
          },
        });
        const envelope = createEnvelope({
          eventType: 'media.render_completed',
          producer: PRODUCER,
          payload: {
            requestId: target.id,
            tripId: target.tripId,
            segmentId: segment.id,
            at: now.toISOString(),
          },
        });
        await enqueueOutbox(tx, envelope, target.tripId);
      });
      this.logger.log(`Render OK request=${target.id} → ${renderedKey}`);
    } catch (err) {
      const reason = categorizeRenderError(err);
      const renderError = renderErrorMessage(err);
      await this.repo.runInTx(async (tx) => {
        await tx.videoAccessRequest.update({
          where: { id: target.id },
          data: { renderStatus: VideoRenderStatus.FAILED, renderError },
        });
        const envelope = createEnvelope({
          eventType: 'media.render_failed',
          producer: PRODUCER,
          payload: {
            requestId: target.id,
            tripId: target.tripId,
            reason,
            at: now.toISOString(),
          },
        });
        await enqueueOutbox(tx, envelope, target.tripId);
      });
      this.logger.warn(
        { requestId: target.id, tripId: target.tripId, reason },
        'Render de video FALLÓ; se reintentará si quedan intentos',
      );
    }
  }

  /** Resuelve el segmento (por id explícito o el último del viaje) — mismo criterio que streamAccess. */
  private async resolveSegment(
    segmentId: string | null,
    tripId: string,
  ): Promise<{ id: string; s3Key: string }> {
    const segment = await this.repo.findSegmentForRender(segmentId, tripId);
    if (!segment) throw new NotFoundError('Segmento de video no encontrado', { tripId });
    return segment;
  }
}

/** CATEGORÍA técnica del fallo (para el evento `media.render_failed` · SIN PII): clase de error de dominio. */
function categorizeRenderError(err: unknown): string {
  if (err instanceof NotFoundError) return 'SOURCE_NOT_FOUND';
  if (err instanceof Error) {
    if (err.name === 'ExternalServiceError') return 'STORAGE_OR_RENDER_FAILED';
    if (err.name === 'ValidationError') return 'INVALID_INPUT';
    return err.name || 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/** Mensaje técnico truncado para `renderError` (SIN PII: son strings técnicos de dominio, no datos del video). */
function renderErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.slice(0, RENDER_ERROR_MAX);
}
