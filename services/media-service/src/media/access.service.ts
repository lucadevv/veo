/**
 * AccessService — BR-S02 (acceso a video con doble autorización + watermark).
 *
 * Flujo:
 *  1. Un operador crea una solicitud con un `reason` (>20 chars). Tener rol de operador NO basta.
 *  2. Un COMPLIANCE_SUPERVISOR con MFA fresca (StepUpMfaGuard, en el controlador) la aprueba.
 *  3. La aprobación genera una URL firmada de S3 válida 5 minutos + un watermark dinámico con el
 *     email del operador, incrementa `accessedCount` y publica un evento de auditoría.
 *
 * El almacenamiento (S3/MinIO) va detrás de un puerto; el watermark es una función pura.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { STORAGE_PORT, type StoragePort } from '../ports/storage/storage.port';
import { buildWatermark } from './watermark';
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

export interface ApproveResult {
  requestId: string;
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

  /** Paso 1: crea la solicitud de acceso. Valida el motivo (>20 chars — BR-S02). */
  async requestAccess(input: CreateAccessRequestInput): Promise<{ id: string; status: 'PENDING' }> {
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
      },
    });
    return { id, status: 'PENDING' };
  }

  /**
   * Paso 2: aprobación por COMPLIANCE_SUPERVISOR (RBAC + MFA fresca verificados en el controlador).
   * Genera URL firmada (5 min) + watermark, incrementa accessedCount y emite evento de auditoría.
   */
  async approveAccess(requestId: string, approverId: string, now = new Date()): Promise<ApproveResult> {
    const req = await this.prisma.read.videoAccessRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('Solicitud de acceso no encontrada');
    if (req.approvedAt) throw new ConflictError('La solicitud ya fue aprobada');

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
        data: { approvedBy: approverId, approvedAt: now, signedUrlExpiresAt: expiresAt, watermark },
      });
      await tx.mediaSegment.update({
        where: { id: segment.id },
        data: { accessedCount: { increment: 1 }, lastAccessedAt: now },
      });
      // Auditoría: audit-service consume este evento para la cadena de custodia (BR-S02).
      const envelope = createEnvelope({
        eventType: 'media.access_granted',
        producer: PRODUCER,
        payload: {
          requestId: req.id,
          tripId: req.tripId,
          segmentId: segment.id,
          operatorId: req.requestedBy,
          operatorEmail: req.requestedByEmail,
          approvedBy: approverId,
          watermark,
          expiresAt: expiresAt.toISOString(),
          at: now.toISOString(),
        },
      });
      await enqueueOutbox(tx, envelope, req.tripId);
    });

    this.logger.log(
      `Acceso a video aprobado request=${req.id} segment=${segment.id} por=${approverId}`,
    );
    return { requestId: req.id, signedUrl, watermark, expiresAt, segmentId: segment.id };
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
