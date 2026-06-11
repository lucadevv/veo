/**
 * Calificaciones. Crear es comando (REST interno firmado); el agregado de un sujeto es lectura
 * (gRPC GetAggregate, promedio rolling 30d + flags).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DownstreamError, GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { grpcIdentityMetadata, INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { GRPC_RATING, REST_RATING } from '../infra/downstream.tokens';
import type { AggregateReply } from '../infra/grpc-types';
import {
  type AggregateView,
  type CreateRatingDto,
  type MyRatingView,
  type RatingView,
} from './dto/rating.dto';

@Injectable()
export class RatingsService {
  constructor(
    @Inject(GRPC_RATING) private readonly ratingGrpc: GrpcServiceClient,
    @Inject(REST_RATING) private readonly ratingRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  create(user: AuthenticatedUser, dto: CreateRatingDto): Promise<RatingView> {
    return this.ratingRest.post<RatingView>('/ratings', { identity: user, body: dto });
  }

  /**
   * MI calificación de un viaje (la que ESTE pasajero le dio al conductor), o `null` si aún no calificó.
   * REST interno firmado: el rating-service deriva el rater de la identidad y filtra por él (anti-IDOR),
   * así un pasajero NUNCA obtiene el rating de otro ni el que el conductor le puso. El downstream
   * devuelve 404 cuando no existe; acá lo colapsamos a `null` para que el contrato de la app sea
   * `{...} | null` (la app distingue "no calificado" de un error real sin parsear el cuerpo del 404).
   */
  async getMyRatingForTrip(user: AuthenticatedUser, tripId: string): Promise<MyRatingView | null> {
    try {
      const r = await this.ratingRest.get<RatingView>('/ratings', {
        identity: user,
        query: { tripId },
      });
      return { stars: r.stars, comment: r.comment, createdAt: r.createdAt };
    } catch (err) {
      // "Sin calificación tuya para este viaje" → null (no es un error para la app). Cualquier otro
      // error (5xx, timeout, etc.) se propaga: NO lo enmascaramos como "sin rating".
      if (err instanceof DownstreamError && err.status === 404) return null;
      throw err;
    }
  }

  async getAggregate(user: AuthenticatedUser, subjectId: string): Promise<AggregateView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.ratingGrpc.call<AggregateReply>('GetAggregate', { subjectId }, meta);
    return {
      subjectId: reply.subjectId,
      role: reply.role,
      rollingAvg30d: reply.rollingAvg30d,
      count30d: reply.count30d,
      flagged: reply.flagged,
      flagReason: reply.flagReason || null,
      lastComputedAt: reply.lastComputedAt || null,
    };
  }
}
