/**
 * Pánico del pasajero. El disparo es un comando crítico (REST interno firmado) y la lectura del
 * estado es gRPC GetPanic. El endpoint de disparo NUNCA se rate-limita (ver controller).
 */
import { Inject, Injectable } from '@nestjs/common';
import { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { grpcIdentityMetadata, INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError, NotFoundError } from '@veo/utils';
import { GRPC_PANIC, REST_PANIC } from '../infra/downstream.tokens';
import type { PanicReply } from '../infra/grpc-types';
import { type PanicTriggerResult, type PanicView, type TriggerPanicDto } from './dto/panic.dto';

@Injectable()
export class PanicService {
  constructor(
    @Inject(GRPC_PANIC) private readonly panicGrpc: GrpcServiceClient,
    @Inject(REST_PANIC) private readonly panicRest: InternalRestClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  trigger(user: AuthenticatedUser, dto: TriggerPanicDto): Promise<PanicTriggerResult> {
    return this.panicRest.post<PanicTriggerResult>('/panic', {
      identity: user,
      idempotencyKey: dto.dedupKey,
      body: { tripId: dto.tripId, dedupKey: dto.dedupKey, geo: dto.geo, signature: dto.signature },
    });
  }

  /**
   * Estado de una alerta de pánico vía gRPC GetPanic.
   * Anti-IDOR (mismo gate que TripsService.videoGrant/tip): el GetPanic del panic-service es un getter
   * crudo (sin auth, lo usan operadores con su propio RBAC), así que la pertenencia se verifica ACÁ en
   * el BFF. Sin esto, cualquier pasajero autenticado leía la ubicación exacta (geo) de otra persona en
   * pánico por id (fuga PII/ubicación, Ley 29733).
   */
  async getPanic(user: AuthenticatedUser, id: string): Promise<PanicView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.panicGrpc.call<PanicReply>('GetPanic', { id }, meta);
    if (!reply.found) throw new NotFoundError('Alerta de pánico no encontrada');
    if (reply.passengerId !== user.userId) {
      throw new ForbiddenError('La alerta de pánico no pertenece al usuario');
    }
    return {
      id: reply.id,
      tripId: reply.tripId,
      passengerId: reply.passengerId,
      status: reply.status,
      geo: { lat: reply.geoLat, lon: reply.geoLon },
      triggeredAt: reply.triggeredAt,
      acknowledgedAt: reply.acknowledgedAt || null,
    };
  }
}
