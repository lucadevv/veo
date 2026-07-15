/**
 * Puerto + adaptador Prisma del feature `media/` (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts / *.worker.ts / *.sweeper.ts toca `this.prisma` directo). Espeja el molde
 * del panic.repository (token DI + interfaz + adaptador, cliente dual read/write, `runInTx`).
 *
 * UN solo repo para el feature: los DOS modelos del schema `media` (MediaSegment · VideoAccessRequest)
 * están entrelazados en casi todos los flujos (streamAccess lee segmento + solicitud; eraseTrip y el
 * barrido de retención borran ambos; el render une solicitud↔segmento), así que separarlos duplicaría
 * las lecturas de segmento en dos repos. Igual que panic: un repo por feature.
 *
 * Las lecturas y las escrituras de un solo statement son métodos del puerto (con la query Prisma movida
 * TAL CUAL adentro). Las transacciones multi-statement (update de estado + `enqueueOutbox` en la MISMA tx,
 * FOUNDATION §6) se abren con `runInTx`: el CUERPO transaccional SIGUE viviendo en el service/worker, que
 * recibe el cliente de transacción tipado `Prisma.TransactionClient` (el real). Los cuerpos combinan
 * mutaciones de dominio con `enqueueOutbox`, que exige el delegate `outboxEvent` completo; un puerto
 * estrecho re-implementaría a mano los tipos de Prisma en un flujo de SEGURIDAD/compliance — no se paga.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  VideoRenderStatus,
  type MediaSegment,
  type VideoAccessRequest,
  type VideoAccessStatus,
} from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const MEDIA_REPO = Symbol('MEDIA_REPO');

/** Proyección mínima de una solicitud a rendir (select del batch del worker). */
export type RenderTarget = Pick<
  VideoAccessRequest,
  'id' | 'tripId' | 'segmentId' | 'requestedByEmail'
>;

/** Proyección del segmento abierto que consume RecordingService (findOpenSegment). */
export type OpenSegment = Pick<
  MediaSegment,
  'id' | 'startedAt' | 's3Key' | 'egressId' | 'hasIncident' | 'hasPanic'
>;

/** Proyección de segmento para el pipeline de render (resolveSegment). */
export type SegmentSource = Pick<MediaSegment, 'id' | 's3Key'>;

/** Proyección de segmento del barrido de retención (keyset). */
export type DueSegment = Pick<MediaSegment, 'id' | 's3Key' | 'tripId'>;

/** Proyección de segmento (metadatos, sin URLs) que expone `listSegments` (BR-S02). */
export type SegmentMetadata = Pick<
  MediaSegment,
  | 'id'
  | 'tripId'
  | 'startedAt'
  | 'endedAt'
  | 'sizeBytes'
  | 'codec'
  | 'retentionUntil'
  | 'accessedCount'
  | 'hasPanic'
  | 'hasIncident'
>;

/** Datos para crear una solicitud de acceso (PENDING) — sin filtrar por tipos de Prisma en el service. */
export interface CreateAccessRequestData {
  id: string;
  tripId: string;
  segmentId: string | null;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: VideoAccessStatus;
}

/** Puerto: el feature `media/` depende de esto, NO de Prisma. */
export interface MediaRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (mutación de dominio +
   * `enqueueOutbox` en la MISMA tx) vive en el service/worker; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  // ── Segmentos (lecturas) ─────────────────────────────────────────────────────────────────────────
  /** Segmento por id (read). `null` si no existe. */
  findSegmentById(id: string): Promise<MediaSegment | null>;
  /** Primer segmento del viaje (read), sin orden — solo prueba existencia de video (BR-S02). */
  findFirstSegmentByTrip(tripId: string): Promise<MediaSegment | null>;
  /** Último segmento del viaje (read, `startedAt desc`). */
  findLatestSegmentByTrip(tripId: string): Promise<MediaSegment | null>;
  /** Segmento ABIERTO (endedAt null) más reciente del viaje (read, proyección). */
  findOpenSegment(tripId: string): Promise<OpenSegment | null>;
  /** Fuente del render: segmento por id explícito, o el último del viaje (read, proyección). */
  findSegmentForRender(segmentId: string | null, tripId: string): Promise<SegmentSource | null>;
  /** Metadatos de los segmentos de un viaje (read, `startedAt asc`, sin URLs). */
  listSegmentsByTrip(tripId: string): Promise<SegmentMetadata[]>;
  /** id + s3Key de todos los segmentos de un viaje (read) — derecho al olvido. */
  listSegmentKeysByTrip(tripId: string): Promise<SegmentSource[]>;
  /** Segmentos de un viaje ordenados `startedAt asc` (read) — lectura gRPC de metadatos. */
  listSegmentsByTripAsc(tripId: string): Promise<MediaSegment[]>;
  /**
   * Página del barrido de retención por keyset (`id asc`, `take`, cursor opcional): segmentos con
   * `retentionUntil` vencida (`not null` y `<= now`). Proyección {id, s3Key, tripId} (read).
   */
  findDueSegmentsPage(now: Date, take: number, cursorId?: string): Promise<DueSegment[]>;
  /** tripIds del set que TODAVÍA tienen segmentos vivos (read, groupBy — sin N+1). */
  findTripIdsWithLiveSegments(tripIds: string[]): Promise<string[]>;

  // ── Solicitudes de acceso (lecturas) ─────────────────────────────────────────────────────────────
  /** Solicitud de acceso por id (read). `null` si no existe. */
  findAccessRequestById(id: string): Promise<VideoAccessRequest | null>;
  /** Lista de solicitudes (read), opcionalmente por estado; `createdAt desc`. */
  listAccessRequests(status?: VideoAccessStatus): Promise<VideoAccessRequest[]>;
  /** ids de TODAS las solicitudes de un viaje (read) — copias derivadas por clave computada. */
  listAccessRequestIdsByTrip(tripId: string): Promise<{ id: string }[]>;
  /** ids de las solicitudes que apuntan a alguno de los segmentos dados (read). */
  listAccessRequestIdsBySegments(segmentIds: string[]): Promise<{ id: string }[]>;
  /** ids de las solicitudes de cualquiera de los viajes dados (read). */
  listAccessRequestIdsByTrips(tripIds: string[]): Promise<{ id: string }[]>;
  /**
   * Batch de candidatas a rendir (read, `renderRequestedAt asc`, `take`): PENDING o PROCESSING colgada
   * (renderRequestedAt < staleBefore), siempre con intentos disponibles (< maxAttempts). Proyección.
   */
  findRenderCandidates(
    staleBefore: Date,
    maxAttempts: number,
    take: number,
  ): Promise<RenderTarget[]>;

  // ── Escrituras de un solo statement ──────────────────────────────────────────────────────────────
  /** Crea la solicitud de acceso (write, status PENDING). */
  createAccessRequest(data: CreateAccessRequestData): Promise<void>;
  /**
   * (Re)dispara el render lazy con un UPDATE CONDICIONAL guardado (write): pasa a PENDING SOLO si la fila
   * sigue en `renderStatus null` o `FAILED & attempts < maxAttempts` (excluye READY/PENDING/PROCESSING —
   * cierra el lost-update contra el worker). Devuelve cuántas filas movió (0 = otro carril la tomó/dejó lista).
   */
  claimLazyRender(id: string, maxAttempts: number, now: Date): Promise<number>;
  /** Escala la retención de un segmento a indefinida por pánico (write). */
  escalatePanicRetention(segmentId: string): Promise<void>;
  /**
   * REAPER terminal (write): marca FAILED las PROCESSING colgadas (renderRequestedAt < staleBefore) que ya
   * agotaron los intentos (>= maxAttempts), para que streamAccess corte el loop. Janitorial: sin evento.
   */
  reapStaleRenders(staleBefore: Date, maxAttempts: number): Promise<void>;
  /**
   * Toma atómicamente UNA solicitud para render (write): pasa a PROCESSING (attempts++) SOLO si sigue
   * PENDING o PROCESSING-colgada con intentos disponibles. Devuelve cuántas movió (0 = otra réplica la tomó).
   */
  claimRenderTarget(
    id: string,
    staleBefore: Date,
    maxAttempts: number,
    now: Date,
  ): Promise<number>;
  /** Borra en batch los segmentos dados (write) — barrido de retención. */
  deleteSegments(ids: string[]): Promise<void>;
}

@Injectable()
export class PrismaMediaRepository implements MediaRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findSegmentById(id: string): Promise<MediaSegment | null> {
    return this.prisma.read.mediaSegment.findUnique({ where: { id } });
  }

  findFirstSegmentByTrip(tripId: string): Promise<MediaSegment | null> {
    return this.prisma.read.mediaSegment.findFirst({ where: { tripId } });
  }

  findLatestSegmentByTrip(tripId: string): Promise<MediaSegment | null> {
    return this.prisma.read.mediaSegment.findFirst({
      where: { tripId },
      orderBy: { startedAt: 'desc' },
    });
  }

  findOpenSegment(tripId: string): Promise<OpenSegment | null> {
    return this.prisma.read.mediaSegment.findFirst({
      where: { tripId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        s3Key: true,
        egressId: true,
        hasIncident: true,
        hasPanic: true,
      },
    });
  }

  findSegmentForRender(segmentId: string | null, tripId: string): Promise<SegmentSource | null> {
    return segmentId
      ? this.prisma.read.mediaSegment.findUnique({
          where: { id: segmentId },
          select: { id: true, s3Key: true },
        })
      : this.prisma.read.mediaSegment.findFirst({
          where: { tripId },
          orderBy: { startedAt: 'desc' },
          select: { id: true, s3Key: true },
        });
  }

  listSegmentsByTrip(tripId: string): Promise<SegmentMetadata[]> {
    return this.prisma.read.mediaSegment.findMany({
      where: { tripId },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        tripId: true,
        startedAt: true,
        endedAt: true,
        sizeBytes: true,
        codec: true,
        retentionUntil: true,
        accessedCount: true,
        hasPanic: true,
        hasIncident: true,
      },
    });
  }

  listSegmentKeysByTrip(tripId: string): Promise<SegmentSource[]> {
    return this.prisma.read.mediaSegment.findMany({
      where: { tripId },
      select: { id: true, s3Key: true },
    });
  }

  listSegmentsByTripAsc(tripId: string): Promise<MediaSegment[]> {
    return this.prisma.read.mediaSegment.findMany({
      where: { tripId },
      orderBy: { startedAt: 'asc' },
    });
  }

  findDueSegmentsPage(now: Date, take: number, cursorId?: string): Promise<DueSegment[]> {
    return this.prisma.read.mediaSegment.findMany({
      where: { retentionUntil: { not: null, lte: now } },
      select: { id: true, s3Key: true, tripId: true },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  async findTripIdsWithLiveSegments(tripIds: string[]): Promise<string[]> {
    const groups = await this.prisma.read.mediaSegment.groupBy({
      by: ['tripId'],
      where: { tripId: { in: tripIds } },
      _count: { _all: true },
    });
    const alive: string[] = [];
    for (const group of groups) {
      if (group.tripId !== null) alive.push(group.tripId);
    }
    return alive;
  }

  findAccessRequestById(id: string): Promise<VideoAccessRequest | null> {
    return this.prisma.read.videoAccessRequest.findUnique({ where: { id } });
  }

  listAccessRequests(status?: VideoAccessStatus): Promise<VideoAccessRequest[]> {
    return this.prisma.read.videoAccessRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  listAccessRequestIdsByTrip(tripId: string): Promise<{ id: string }[]> {
    return this.prisma.read.videoAccessRequest.findMany({
      where: { tripId },
      select: { id: true },
    });
  }

  listAccessRequestIdsBySegments(segmentIds: string[]): Promise<{ id: string }[]> {
    return this.prisma.read.videoAccessRequest.findMany({
      where: { segmentId: { in: segmentIds } },
      select: { id: true },
    });
  }

  listAccessRequestIdsByTrips(tripIds: string[]): Promise<{ id: string }[]> {
    return this.prisma.read.videoAccessRequest.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
  }

  findRenderCandidates(
    staleBefore: Date,
    maxAttempts: number,
    take: number,
  ): Promise<RenderTarget[]> {
    return this.prisma.read.videoAccessRequest.findMany({
      where: {
        renderAttempts: { lt: maxAttempts },
        OR: [
          { renderStatus: VideoRenderStatus.PENDING },
          {
            renderStatus: VideoRenderStatus.PROCESSING,
            renderRequestedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: { renderRequestedAt: 'asc' },
      take,
      select: { id: true, tripId: true, segmentId: true, requestedByEmail: true },
    });
  }

  async createAccessRequest(data: CreateAccessRequestData): Promise<void> {
    await this.prisma.write.videoAccessRequest.create({ data });
  }

  async claimLazyRender(id: string, maxAttempts: number, now: Date): Promise<number> {
    const claimed = await this.prisma.write.videoAccessRequest.updateMany({
      where: {
        id,
        OR: [
          { renderStatus: null },
          {
            renderStatus: VideoRenderStatus.FAILED,
            renderAttempts: { lt: maxAttempts },
          },
        ],
      },
      data: { renderStatus: VideoRenderStatus.PENDING, renderRequestedAt: now, renderError: null },
    });
    return claimed.count;
  }

  async escalatePanicRetention(segmentId: string): Promise<void> {
    await this.prisma.write.mediaSegment.update({
      where: { id: segmentId },
      data: { hasPanic: true, retentionUntil: null },
    });
  }

  async reapStaleRenders(staleBefore: Date, maxAttempts: number): Promise<void> {
    await this.prisma.write.videoAccessRequest.updateMany({
      where: {
        renderStatus: VideoRenderStatus.PROCESSING,
        renderRequestedAt: { lt: staleBefore },
        renderAttempts: { gte: maxAttempts },
      },
      data: {
        renderStatus: VideoRenderStatus.FAILED,
        renderError: 'render abandonado: se alcanzó el máximo de intentos sin completar',
      },
    });
  }

  async claimRenderTarget(
    id: string,
    staleBefore: Date,
    maxAttempts: number,
    now: Date,
  ): Promise<number> {
    const claimed = await this.prisma.write.videoAccessRequest.updateMany({
      where: {
        id,
        renderAttempts: { lt: maxAttempts },
        OR: [
          { renderStatus: VideoRenderStatus.PENDING },
          {
            renderStatus: VideoRenderStatus.PROCESSING,
            renderRequestedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        renderStatus: VideoRenderStatus.PROCESSING,
        renderRequestedAt: now,
        renderAttempts: { increment: 1 },
      },
    });
    return claimed.count;
  }

  async deleteSegments(ids: string[]): Promise<void> {
    await this.prisma.write.mediaSegment.deleteMany({ where: { id: { in: ids } } });
  }
}
