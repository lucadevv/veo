/**
 * SecurityService — incidentes de pánico: listado/detalle (panic-service tiene listado real),
 * acknowledge/resolve/evidence (REST interno firmado). Toda acción sensible se audita.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PanicSummary } from '@veo/api-client';
import { REST_PANIC } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { ListPanicsQueryDto, ResolvePanicDto, PanicEvidenceDto } from './dto/panic.dto';

interface PanicEntity {
  id: string;
  tripId: string;
  passengerId: string;
  triggeredAt: string;
  geoPoint: { lat: number; lon: number };
  dedupKey: string;
  status: string;
  evidenceS3Keys: string[];
  acknowledgedAt?: string;
  ackBy?: string;
}

export interface PanicDetailView extends PanicSummary {
  evidenceS3Keys: string[];
  ackBy: string | null;
}

@Injectable()
export class SecurityService {
  constructor(
    @Inject(REST_PANIC) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  async listPanics(identity: AuthenticatedUser, query: ListPanicsQueryDto): Promise<PanicSummary[]> {
    const list = await this.rest.get<PanicEntity[]>('/panic', { identity, query: { status: query.status } });
    return list.map(toPanicSummary);
  }

  async getPanic(identity: AuthenticatedUser, id: string): Promise<PanicDetailView> {
    const p = await this.rest.get<PanicEntity>(`/panic/${id}`, { identity });
    return { ...toPanicSummary(p), evidenceS3Keys: p.evidenceS3Keys ?? [], ackBy: p.ackBy ?? null };
  }

  async ack(identity: AuthenticatedUser, id: string): Promise<PanicDetailView> {
    const p = await this.rest.post<PanicEntity>(`/panic/${id}/ack`, { identity });
    await this.audit.record(identity, { action: 'panic.ack', resourceType: 'panic', resourceId: id });
    return { ...toPanicSummary(p), evidenceS3Keys: p.evidenceS3Keys ?? [], ackBy: p.ackBy ?? null };
  }

  async resolve(identity: AuthenticatedUser, id: string, dto: ResolvePanicDto): Promise<PanicDetailView> {
    const p = await this.rest.post<PanicEntity>(`/panic/${id}/resolve`, {
      identity,
      body: { resolution: dto.resolution },
    });
    await this.audit.record(identity, {
      action: 'panic.resolve',
      resourceType: 'panic',
      resourceId: id,
      payload: { resolution: dto.resolution },
    });
    return { ...toPanicSummary(p), evidenceS3Keys: p.evidenceS3Keys ?? [], ackBy: p.ackBy ?? null };
  }

  async addEvidence(
    identity: AuthenticatedUser,
    id: string,
    dto: PanicEvidenceDto,
  ): Promise<{ evidenceS3Keys: string[]; protectedKeys: string[] }> {
    const res = await this.rest.post<{ evidenceS3Keys: string[]; protectedKeys: string[] }>(
      `/panic/${id}/evidence`,
      { identity, body: { keys: dto.keys, finalize: dto.finalize } },
    );
    await this.audit.record(identity, {
      action: 'panic.evidence',
      resourceType: 'panic',
      resourceId: id,
      payload: { count: dto.keys.length },
    });
    return res;
  }
}

function toPanicSummary(p: PanicEntity): PanicSummary {
  return {
    id: p.id,
    tripId: p.tripId,
    passengerId: p.passengerId,
    status: p.status,
    geo: p.geoPoint,
    triggeredAt: p.triggeredAt,
    acknowledgedAt: p.acknowledgedAt ?? null,
  };
}
