/**
 * AuditService (lectura) — proxea las consultas de auditoría a audit-service (REST interno firmado)
 * y mapea a la vista pública auditEntryView de @veo/api-client. Paginación por cursor `beforeSeq`.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { AuditEntryView } from '@veo/api-client';
import { REST_AUDIT } from '../infra/tokens';
import type { AuditQueryDto, AuditVerifyDto } from './dto/audit-query.dto';

interface AuditEntryResponse {
  id: string;
  seq: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
}

export interface VerifyResponse {
  valid: boolean;
  checked: number;
  fromSeq: string | null;
  toSeq: string | null;
  brokenAtSeq?: string;
  reason?: string;
}

const DEFAULT_LIMIT = 50;

@Injectable()
export class AuditService {
  constructor(@Inject(REST_AUDIT) private readonly rest: InternalRestClient) {}

  async list(
    identity: AuthenticatedUser,
    query: AuditQueryDto,
  ): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const entries = await this.rest.get<AuditEntryResponse[]>('/audit', {
      identity,
      query: {
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        actorId: query.actorId,
        action: query.action,
        limit,
        beforeSeq: query.beforeSeq,
      },
    });
    const items = entries.map(toAuditEntryView);
    // El listado viene en orden descendente por seq; el siguiente cursor es el seq del último.
    const nextCursor = items.length === limit ? (items[items.length - 1]?.seq ?? null) : null;
    return { items, nextCursor };
  }

  verify(identity: AuthenticatedUser, query: AuditVerifyDto): Promise<VerifyResponse> {
    return this.rest.get<VerifyResponse>('/audit/verify', {
      identity,
      query: { fromSeq: query.fromSeq, toSeq: query.toSeq },
    });
  }
}

export function toAuditEntryView(e: AuditEntryResponse): AuditEntryView {
  return {
    id: e.id,
    seq: e.seq,
    actorId: e.actorId ?? null,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    at: e.occurredAt,
  };
}
