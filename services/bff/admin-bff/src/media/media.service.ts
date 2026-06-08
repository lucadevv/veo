/**
 * MediaService — acceso a video con doble-auth (BR-S07): un operador SOLICITA y otro APRUEBA con
 * step-up MFA fresco. La aprobación devuelve una URL firmada con watermark. Todo se audita.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_MEDIA } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { RequestAccessDto } from './dto/media.dto';

interface AccessRequestReply {
  id: string;
  status: string;
}
export interface ApprovedAccess {
  requestId: string;
  signedUrl: string;
  watermark: string;
  expiresAt: string;
  segmentId: string;
}
export interface SegmentView {
  id: string;
  tripId: string;
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number;
  codec: string;
  retentionUntil: string | null;
  accessedCount: number;
  hasPanic: boolean;
  hasIncident: boolean;
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(REST_MEDIA) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  async requestAccess(identity: AuthenticatedUser, dto: RequestAccessDto): Promise<AccessRequestReply> {
    const res = await this.rest.post<AccessRequestReply>('/media/access', { identity, body: dto });
    await this.audit.record(identity, {
      action: 'media.access_request',
      resourceType: 'media_access',
      resourceId: res.id,
      payload: { tripId: dto.tripId, segmentId: dto.segmentId, reason: dto.reason },
    });
    return res;
  }

  async approveAccess(identity: AuthenticatedUser, requestId: string): Promise<ApprovedAccess> {
    const res = await this.rest.post<ApprovedAccess>(`/media/access/${requestId}/approve`, { identity });
    await this.audit.record(identity, {
      action: 'media.access_approve',
      resourceType: 'media_access',
      resourceId: requestId,
      payload: { segmentId: res.segmentId, expiresAt: res.expiresAt },
    });
    return res;
  }

  async segments(identity: AuthenticatedUser, tripId: string): Promise<SegmentView[]> {
    const res = await this.rest.get<SegmentView[]>('/media/segments', { identity, query: { tripId } });
    // Listar qué segmentos de video de cabina existen para un viaje (incl. flags hasPanic/hasIncident)
    // es una lectura sensible: debe quedar en la pista de rendición de cuentas (Ley 29733), igual que
    // requestAccess/approveAccess. fail-closed: si el audit falla, el listado falla.
    await this.audit.record(identity, {
      action: 'media.segments_list',
      resourceType: 'media_segments',
      resourceId: tripId,
      payload: {
        tripId,
        segmentCount: res.length,
        hasPanic: res.some((s) => s.hasPanic),
        hasIncident: res.some((s) => s.hasIncident),
      },
    });
    return res;
  }
}
