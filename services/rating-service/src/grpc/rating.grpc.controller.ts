/**
 * Controlador gRPC de rating (paquete veo.rating.v1.RatingService).
 * Lectura síncrona del agregado para el scoring de dispatch. Devuelve `found=false` en vez de
 * lanzar, para que el llamante decida (evita ruido de errores cross-servicio).
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { RatingsService } from '../ratings/ratings.service';

interface GetAggregateRequest {
  subjectId: string;
}

interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string;
  lastComputedAt: string;
  found: boolean;
}

const EMPTY: AggregateReply = {
  subjectId: '',
  role: '',
  rollingAvg30d: 0,
  count30d: 0,
  flagged: false,
  flagReason: '',
  lastComputedAt: '',
  found: false,
};

@Controller()
export class RatingGrpcController {
  constructor(private readonly ratings: RatingsService) {}

  @GrpcMethod('RatingService', 'GetAggregate')
  async getAggregate({ subjectId }: GetAggregateRequest): Promise<AggregateReply> {
    const agg = await this.ratings.getAggregate(subjectId);
    if (!agg) return EMPTY;
    return {
      subjectId: agg.subjectId,
      role: agg.role,
      rollingAvg30d: agg.rollingAvg30d,
      count30d: agg.count30d,
      flagged: agg.flagged,
      flagReason: agg.flagReason ?? '',
      lastComputedAt: agg.lastComputedAt.toISOString(),
      found: true,
    };
  }
}
