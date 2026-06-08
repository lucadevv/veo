/**
 * Controlador gRPC de media (paquete veo.media.v1.MediaService).
 * Lectura síncrona de metadatos de segmentos para otros servicios (panic, audit, compliance).
 * NUNCA expone URLs de video: la visualización exige el flujo de doble autorización (BR-S02).
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../infra/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  @GrpcMethod('MediaService', 'GetSegments')
  async getSegments({ tripId }: GetSegmentsRequest): Promise<SegmentsReply> {
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
