/**
 * Controlador gRPC de media (paquete veo.media.v1.MediaService).
 * Lectura síncrona de metadatos de segmentos para otros servicios (panic, audit, compliance).
 * NUNCA expone URLs de video: la visualización exige el flujo de doble autorización (BR-S02).
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

interface GetSegmentsRequest {
  tripId: string;
}
interface SegmentReply {
  id: string;
  tripId: string;
  startedAt: string;
  endedAt: string;
  s3Key: string;
  sizeBytes: number;
  codec: string;
  retentionUntil: string;
  accessedCount: number;
  hasPanic: boolean;
  hasIncident: boolean;
}
interface SegmentsReply {
  segments: SegmentReply[];
}

@Controller()
export class MediaGrpcController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  @GrpcMethod('MediaService', 'GetSegments')
  async getSegments({ tripId }: GetSegmentsRequest, metadata: Metadata): Promise<SegmentsReply> {
    const identity = verifyGrpcIdentity(metadata, this.secret);
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    const rows = await this.prisma.read.mediaSegment.findMany({
      where: { tripId },
      orderBy: { startedAt: 'asc' },
    });
    return {
      segments: rows.map((r) => ({
        id: r.id,
        tripId: r.tripId,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? '',
        s3Key: r.s3Key,
        sizeBytes: Number(r.sizeBytes),
        codec: r.codec,
        retentionUntil: r.retentionUntil?.toISOString() ?? '',
        accessedCount: r.accessedCount,
        hasPanic: r.hasPanic,
        hasIncident: r.hasIncident,
      })),
    };
  }
}
