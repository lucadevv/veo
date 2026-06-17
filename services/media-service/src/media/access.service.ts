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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import { buildWatermark } from './watermark';
import { VideoAccessStatus } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const PRODUCER = 'media-service';
const MIN_REASON_LENGTH = 20;

export interface CreateAccessRequestInput {
  tripId: string;
  segmentId?: string;
  /** Operador que solicita (su id de usuario). */
  requestedBy: string;
  /** Email del operador (se incrusta en el watermark). */
  requestedByEmail: string;
  reason: string;
}

/** Resultado de una visualización: lo que el cliente necesita para reproducir (NUNCA se persiste el url). */
export interface StreamResult {
  signedUrl: string;
  watermark: string;
  expiresAt: Date;
  segmentId: string;
}

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private readonly signedUrlTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    config: ConfigService<Env, true>,
  ) {
    this.signedUrlTtl = config.getOrThrow<number>('SIGNED_URL_TTL_SECONDS');
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
      const seg = await this.prisma.read.mediaSegment.findUnique({ where: { id: input.segmentId } });
      if (!seg) throw new NotFoundError('Segmento de video no encontrado');
    } else {
      const any = await this.prisma.read.mediaSegment.findFirst({ where: { tripId: input.tripId } });
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
   * Paso 3: VISUALIZACIÓN. SOLO si la solicitud está APPROVED. Genera URL firmada (5 min) + watermark
   * FRESCO con el email del solicitante + timestamp now + id, incrementa accessedCount y AUDITA cada
   * reproducción por outbox (cadena de custodia BR-S02 — cada vista deja rastro). Guard: APPROVED.
   */
  async streamAccess(requestId: string, viewerId: string, now = new Date()): Promise<StreamResult> {
    const req = await this.prisma.read.videoAccessRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('Solicitud de acceso no encontrada');
    if (req.status !== VideoAccessStatus.APPROVED) {
      throw new ForbiddenError('La solicitud no está aprobada');
    }

    const segment = req.segmentId
      ? await this.prisma.read.mediaSegment.findUnique({ where: { id: req.segmentId } })
      : await this.prisma.read.mediaSegment.findFirst({
          where: { tripId: req.tripId },
          orderBy: { startedAt: 'desc' },
        });
    if (!segment) throw new NotFoundError('Segmento de video no encontrado');

    const expiresAt = new Date(now.getTime() + this.signedUrlTtl * 1000);
    const watermark = buildWatermark({
      operatorEmail: req.requestedByEmail,
      requestId: req.id,
      at: now,
    });
    const signedUrl = await this.storage.presignDownloadUrl({
      key: segment.s3Key,
      expiresSeconds: this.signedUrlTtl,
    });

    await this.prisma.write.$transaction(async (tx) => {
      await tx.videoAccessRequest.update({
        where: { id: req.id },
        data: { signedUrlExpiresAt: expiresAt, watermark },
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
    return { signedUrl, watermark, expiresAt, segmentId: segment.id };
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
