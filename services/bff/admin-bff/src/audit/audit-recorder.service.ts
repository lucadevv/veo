/**
 * AuditRecorder — registra acciones admin sensibles en audit-service vía gRPC Record (append-only,
 * hash-chain verificable). Compliance fail-closed: si la grabación falla, la acción falla.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    return this.grpc.call<RecordReply>(
      'Record',
      {
        actorId: identity.userId,
        action: action.action,
        resourceType: action.resourceType,
        resourceId: action.resourceId,
        payloadJson: JSON.stringify(action.payload ?? {}),
      },
      grpcIdentityMetadata(identity, this.secret, this.audience),
    );
  }
}
