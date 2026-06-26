/**
 * AuditRecorder — registra acciones admin sensibles en audit-service vía gRPC Record (append-only,
 * hash-chain verificable). Compliance fail-closed: si la grabación falla, la acción falla.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7 } from '@veo/utils';
import type { GrpcServiceClient, RecordReply } from '@veo/rpc';
import {
  grpcIdentityMetadata,
  INTERNAL_IDENTITY_AUDIENCE,
  type AuthenticatedUser,
  type InternalAudience,
} from '@veo/auth';
import { GRPC_AUDIT } from '../infra/tokens';
import type { Env } from '../config/env.schema';

export interface AuditAction {
  action: string;
  resourceType: string;
  resourceId: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class AuditRecorder {
  private readonly secret: string;

  constructor(
    @Inject(GRPC_AUDIT) private readonly grpc: GrpcServiceClient,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  record(identity: AuthenticatedUser, action: AuditAction): Promise<RecordReply> {
    // IDEMPOTENCIA del registro síncrono: un id ESTABLE generado UNA vez por record(). El GrpcServiceClient
    // reintenta el transporte ante fallos de red transitorios → reusar el mismo eventId hace que el WORM
    // dedupee por eventId (no duplica la fila). Espeja la idempotencia del carril Kafka (recordFromEvent).
    // ALCANCE: esto cubre el retry de TRANSPORTE de un mismo record(). El retry a nivel OPERACIÓN-BFF
    // (doble-submit del operador → dos record() distintos) es OTRO problema: se resuelve con idempotency
    // keys en las mutaciones admin, NO acá.
    const eventId = uuidv7();
    return this.grpc.call<RecordReply>(
      'Record',
      {
        actorId: identity.userId,
        action: action.action,
        resourceType: action.resourceType,
        resourceId: action.resourceId,
        payloadJson: JSON.stringify(action.payload ?? {}),
        eventId,
      },
      grpcIdentityMetadata(identity, this.secret, this.audience),
    );
  }
}
