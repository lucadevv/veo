/**
 * AccessService — BR-S02 (acceso a video con doble autorización + watermark).
 *
 * State machine explícita de la solicitud de acceso:
 *
 *   PENDING ──approveAccess──▶ APPROVED ──streamAccess──▶ (firma URL + watermark, audita cada vista)
 *      │
 *      └────rejectAccess────▶ REJECTED
 *
 * Flujo:
 *  1. requestAccess: un operador crea una solicitud con un `reason` (>20 chars), status PENDING.
 *     Tener rol de operador NO basta.
 *  2. approveAccess / rejectAccess: un COMPLIANCE_SUPERVISOR con MFA fresca (StepUpMfaGuard, en el
 *     controlador) DECIDE la solicitud. Solo transiciona estado — NO genera URL. Audita por outbox.
 *  3. streamAccess: SOLO si está APPROVED. Genera una URL firmada de S3 (5 min) + un watermark FRESCO
 *     por cada visualización, incrementa `accessedCount` y AUDITA cada reproducción (cadena de
 *     custodia BR-S02). Una aprobación habilita ver; cada vista se firma y audita por separado.
 *
 * El almacenamiento (S3/MinIO) va detrás de un puerto; el watermark es una función pura.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  uuidv7,
} from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import { buildWatermark } from './watermark';
import { VideoAccessStatus, VideoRenderStatus, type VideoAccessRequest } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const PRODUCER = 'media-service';
const MIN_REASON_LENGTH = 20;

export interface CreateAccessRequestInput {
  tripId: string;
  segmentId?: string;
  /** Operador que solicita (su id de usuario, de la identidad firmada). */
  requestedBy: string;
  /**
   * Etiqueta de identidad del operador que se QUEMA en el watermark del video (BR-S02). DEBE derivar de la
   * identidad FIRMADA (claim `email` del token admin, fallback `userId`) — NUNCA de un campo del body: el
   * artefacto forense no puede portar un valor controlado por el solicitante (no-repudiación).
   */
  requestedByEmail: string;
  reason: string;
}

/**
 * Discriminador TIPADO del resultado de `streamAccess` (sin strings mágicos: se compara contra estas
 * constantes, jamás contra literales sueltos). El eje de RENDER (quema de watermark) es asíncrono, así que
 * una visualización puede no estar lista todavía → el cliente reintenta (PROCESSING) o reproduce (READY).
 */
export const StreamStatus = {
  PROCESSING: 'PROCESSING',
  READY: 'READY',
} as const;
export type StreamStatus = (typeof StreamStatus)[keyof typeof StreamStatus];

/**
 * Resultado de una visualización (DISCRIMINADO por `status`):
 *  - PROCESSING: la copia con watermark quemado aún no está lista (el worker la está rindiendo). NO hay URL.
 *  - READY: copia lista → URL firmada de la COPIA DERIVADA (NUNCA del crudo) + watermark ya quemado.
 * El `signedUrl` jamás se persiste (efímero, 5 min).
 */
export type StreamResult =
  | { status: typeof StreamStatus.PROCESSING }
  | {
      status: typeof StreamStatus.READY;
      signedUrl: string;
      watermark: string;
      expiresAt: Date;
      segmentId: string;
    };

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private readonly signedUrlTtl: number;
  private readonly maxRenderAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    config: ConfigService<Env, true>,
  ) {
    this.signedUrlTtl = config.getOrThrow<number>('SIGNED_URL_TTL_SECONDS');
    this.maxRenderAttempts = config.getOrThrow<number>('WATERMARK_RENDER_MAX_ATTEMPTS');
  }

  /** Paso 1: crea la solicitud de acceso (status PENDING). Valida el motivo (>20 chars — BR-S02). */
  async requestAccess(
    input: CreateAccessRequestInput,
  ): Promise<{ id: string; status: typeof VideoAccessStatus.PENDING }> {
    if (input.reason.trim().length <= MIN_REASON_LENGTH) {
      throw new ValidationError('El motivo debe tener más de 20 caracteres', {
        field: 'reason',
        minLength: MIN_REASON_LENGTH + 1,
      });
    }

    if (input.segmentId) {
      const seg = await this.prisma.read.mediaSegment.findUnique({
        where: { id: input.segmentId },
      });
      if (!seg) throw new NotFoundError('Segmento de video no encontrado');
    } else {
      const any = await this.prisma.read.mediaSegment.findFirst({
        where: { tripId: input.tripId },
      });
      if (!any) throw new NotFoundError('No hay video grabado para el viaje');
    }

    const id = uuidv7();
    await this.prisma.write.videoAccessRequest.create({
      data: {
        id,
        tripId: input.tripId,
        segmentId: input.segmentId ?? null,
        requestedBy: input.requestedBy,
        requestedByEmail: input.requestedByEmail,
        reason: input.reason.trim(),
        status: VideoAccessStatus.PENDING,
      },
    });
    return { id, status: VideoAccessStatus.PENDING };
  }

  /**
   * Paso 2a: APROBACIÓN por COMPLIANCE_SUPERVISOR (RBAC + MFA fresca verificados en el controlador).
   * SOLO transiciona estado (PENDING → APPROVED) y audita por outbox. NO genera URL ni watermark:
   * eso ocurre en cada `streamAccess`. Guard de transición: solo desde PENDING.
   */
  async approveAccess(requestId: string, approverId: string, now = new Date()) {
    const req = await this.prisma.read.videoAccessRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('Solicitud de acceso no encontrada');
    if (req.status !== VideoAccessStatus.PENDING) {
      throw new ConflictError('La solicitud ya fue decidida');
    }

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const row = await tx.videoAccessRequest.update({
        where: { id: req.id },
        data: { status: VideoAccessStatus.APPROVED, approvedBy: approverId, approvedAt: now },
      });
      // Auditoría: audit-service consume este evento para la cadena de custodia (BR-S02).
      const envelope = createEnvelope({
        eventType: 'media.access_granted',
        producer: PRODUCER,
        payload: {
          requestId: req.id,
          tripId: req.tripId,
          segmentId: req.segmentId ?? undefined,
          operatorId: req.requestedBy,
          approvedBy: approverId,
          expiresAt: now.toISOString(),
          at: now.toISOString(),
        },
      });
      await enqueueOutbox(tx, envelope, req.tripId);
      return row;
    });

    this.logger.log(`Acceso a video aprobado request=${req.id} por=${approverId}`);
    return updated;
  }

  /**
   * Paso 2b: RECHAZO por COMPLIANCE_SUPERVISOR. SOLO transiciona estado (PENDING → REJECTED) y audita.
   * Guard de transición: solo desde PENDING.
   */
  async rejectAccess(requestId: string, rejectorId: string, now = new Date()) {
    const req = await this.prisma.read.videoAccessRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('Solicitud de acceso no encontrada');
    if (req.status !== VideoAccessStatus.PENDING) {
      throw new ConflictError('La solicitud ya fue decidida');
    }

    const updated = await this.prisma.write.$transaction(async (tx) => {
      const row = await tx.videoAccessRequest.update({
        where: { id: req.id },
        data: { status: VideoAccessStatus.REJECTED, rejectedBy: rejectorId, rejectedAt: now },
      });
      const envelope = createEnvelope({
        eventType: 'media.access_rejected',
        producer: PRODUCER,
        payload: {
          requestId: req.id,
          tripId: req.tripId,
          segmentId: req.segmentId ?? undefined,
          operatorId: req.requestedBy,
          rejectedBy: rejectorId,
          at: now.toISOString(),
        },
      });
      await enqueueOutbox(tx, envelope, req.tripId);
      return row;
    });

    this.logger.log(`Acceso a video rechazado request=${req.id} por=${rejectorId}`);
    return updated;
  }

  /**
   * Paso 3: VISUALIZACIÓN (BR-S02 · burn-in Lote 3). SOLO si la solicitud está APPROVED. El operador NUNCA
   * recibe la URL del video CRUDO (`segment.s3Key`): solo la COPIA DERIVADA con watermark quemado
   * (`renderedS3Key`). El quemado es ASÍNCRONO (worker server-side), así que el resultado es DISCRIMINADO:
   *
   *  - renderStatus READY (+ renderedS3Key): firma la COPIA, audita la vista (cadena de custodia), suma
   *    accessedCount → { status: READY, ... }. INVARIANTE: se presigna `renderedS3Key`, jamás el crudo.
   *  - renderStatus null / FAILED(<cap) / READY-sin-key (defensivo): dispara el render (→ PENDING) sin firmar
   *    nada → { status: PROCESSING }. NO incrementa attempts (eso lo hace el worker al TOMAR la solicitud).
   *  - renderStatus PENDING / PROCESSING: idempotente, no re-dispara → { status: PROCESSING }.
   *  - renderStatus FAILED con attempts ≥ cap: error TIPADO (no dejar al operador en loop infinito).
   *
   * Guard de DECISIÓN: el status del request DEBE seguir siendo APPROVED (si no, ForbiddenError como antes).
   */
  async streamAccess(requestId: string, viewerId: string, now = new Date()): Promise<StreamResult> {
    const req = await this.prisma.read.videoAccessRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('Solicitud de acceso no encontrada');
    if (req.status !== VideoAccessStatus.APPROVED) {
      throw new ForbiddenError('La solicitud no está aprobada');
    }

    // READY con copia derivada lista → servila (presigna SOLO la copia, audita la vista). Se pasa la fila YA
    // cargada (no se re-lee): es la misma del guard de DECISIÓN de arriba.
    if (req.renderStatus === VideoRenderStatus.READY && req.renderedS3Key) {
      return this.serveReady(req, req.renderedS3Key, viewerId, now);
    }

    // Render en curso (o recién pedido): idempotente, no re-dispara.
    if (
      req.renderStatus === VideoRenderStatus.PENDING ||
      req.renderStatus === VideoRenderStatus.PROCESSING
    ) {
      return { status: StreamStatus.PROCESSING };
    }

    // Falló de forma PERSISTENTE (agotó los intentos): error tipado, no loop infinito de PROCESSING.
    if (
      req.renderStatus === VideoRenderStatus.FAILED &&
      req.renderAttempts >= this.maxRenderAttempts
    ) {
      throw new ExternalServiceError('El render del video falló de forma persistente', {
        requestId: req.id,
        attempts: req.renderAttempts,
      });
    }

    // Resto (null = nunca rendido · FAILED con intentos disponibles): (re)dispara el render lazy con un
    // UPDATE CONDICIONAL guardado (updateMany filtrado por estado), NO un update incondicional por id.
    //
    // PORQUÉ condicional (lost-update race): entre el read de arriba y este punto, el worker pudo dejar la
    // solicitud READY (o tomarla a PROCESSING). Un update incondicional `{ where: { id } }` PISARÍA ese
    // READY → PENDING y forzaría un re-render espurio de una copia ya lista. El guard `WHERE renderStatus
    // null OR (FAILED & attempts<cap)` EXCLUYE READY/PENDING/PROCESSING: solo dispara desde los estados que
    // legítimamente requieren render. Si `count===0`, otro ya la movió (en curso o lista) → no tocamos nada,
    // el próximo poll la resuelve. Un solo statement → sin $transaction (era over-engineering).
    const claimed = await this.prisma.write.videoAccessRequest.updateMany({
      where: {
        id: req.id,
        OR: [
          { renderStatus: null },
          {
            renderStatus: VideoRenderStatus.FAILED,
            renderAttempts: { lt: this.maxRenderAttempts },
          },
        ],
      },
      data: { renderStatus: VideoRenderStatus.PENDING, renderRequestedAt: now, renderError: null },
    });
    if (claimed.count === 0) {
      // Otro carril ya lo dejó READY o lo tomó (PENDING/PROCESSING): no re-disparamos ni clobereamos.
      this.logger.log(
        `Render ya en curso/listo request=${req.id} (no re-disparado) por=${viewerId}`,
      );
    } else {
      this.logger.log(`Render de video solicitado (lazy) request=${req.id} por=${viewerId}`);
    }
    return { status: StreamStatus.PROCESSING };
  }

  /**
   * Sirve una solicitud cuya copia con watermark quemado ya está READY: presigna la COPIA DERIVADA
   * (`renderedS3Key`, NUNCA el crudo), audita la visualización por outbox (cadena de custodia BR-S02) y
   * suma accessedCount. El `watermark` devuelto es el texto YA quemado (informativo para el cliente).
   */
  private async serveReady(
    req: VideoAccessRequest,
    renderedS3Key: string,
    viewerId: string,
    now: Date,
  ): Promise<Extract<StreamResult, { status: typeof StreamStatus.READY }>> {
    // `req` es la fila YA cargada por streamAccess (FIX: se elimina el segundo findUnique de la misma fila).
    const segment = req.segmentId
      ? await this.prisma.read.mediaSegment.findUnique({ where: { id: req.segmentId } })
      : await this.prisma.read.mediaSegment.findFirst({
          where: { tripId: req.tripId },
          orderBy: { startedAt: 'desc' },
        });
    if (!segment) throw new NotFoundError('Segmento de video no encontrado');

    const expiresAt = new Date(now.getTime() + this.signedUrlTtl * 1000);
    // El watermark ya está QUEMADO en la copia: devolvemos el texto persistido (fallback defensivo al recompute).
    const watermark =
      req.watermark ??
      buildWatermark({ operatorEmail: req.requestedByEmail, requestId: req.id, at: now });
    // INVARIANTE DE SEGURIDAD: se presigna la COPIA DERIVADA con watermark quemado, JAMÁS `segment.s3Key`.
    const signedUrl = await this.storage.presignDownloadUrl({
      key: renderedS3Key,
      expiresSeconds: this.signedUrlTtl,
    });

    await this.prisma.write.$transaction(async (tx) => {
      await tx.videoAccessRequest.update({
        where: { id: req.id },
        data: { signedUrlExpiresAt: expiresAt },
      });
      await tx.mediaSegment.update({
        where: { id: segment.id },
        data: { accessedCount: { increment: 1 }, lastAccessedAt: now },
      });
      // Auditoría: cada visualización se registra (cadena de custodia BR-S02).
      const envelope = createEnvelope({
        eventType: 'media.access_viewed',
        producer: PRODUCER,
        payload: {
          requestId: req.id,
          tripId: req.tripId,
          segmentId: segment.id,
          operatorId: req.requestedBy,
          operatorEmail: req.requestedByEmail,
          viewedBy: viewerId,
          watermark,
          expiresAt: expiresAt.toISOString(),
          at: now.toISOString(),
        },
      });
      await enqueueOutbox(tx, envelope, req.tripId);
    });

    this.logger.log(
      `Visualización de video request=${req.id} segment=${segment.id} por=${viewerId}`,
    );
    return { status: StreamStatus.READY, signedUrl, watermark, expiresAt, segmentId: segment.id };
  }

  /** Lista las solicitudes de acceso, opcionalmente filtradas por estado. Orden createdAt desc. */
  listAccessRequests(filter: { status?: VideoAccessStatus } = {}) {
    return this.prisma.read.videoAccessRequest.findMany({
      where: filter.status ? { status: filter.status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Lista los segmentos de un viaje (metadatos, sin URLs — BR-S02). */
  listSegments(tripId: string): Promise<
    {
      id: string;
      tripId: string;
      startedAt: Date;
      endedAt: Date | null;
      sizeBytes: bigint;
      codec: string;
      retentionUntil: Date | null;
      accessedCount: number;
      hasPanic: boolean;
      hasIncident: boolean;
    }[]
  > {
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
}
