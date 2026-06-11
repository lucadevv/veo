/**
 * MediaService — acceso a video con doble-auth (BR-S07): un operador SOLICITA y otro APRUEBA con
 * step-up MFA fresco. La aprobación devuelve una URL firmada con watermark. Todo se audita.
 */
import { ForbiddenException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient, type GrpcServiceClient, type TripReply } from '@veo/rpc';
import { grpcIdentityMetadata, type AuthenticatedUser } from '@veo/auth';
import { canAccessLiveCabin, normalizeTripStatus } from '@veo/api-client';
import { GRPC_TRIP, REST_MEDIA } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import type { LiveAccessDto, RequestAccessDto } from './dto/media.dto';

interface AccessRequestReply {
  id: string;
  status: string;
}
/** Token de cámara EN VIVO (solo-suscripción) emitido por media-service para el muro del admin. */
export interface LiveViewerToken {
  roomName: string;
  token: string;
  url: string;
  expiresInSeconds: number;
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
  private readonly secret: string;

  constructor(
    @Inject(REST_MEDIA) private readonly rest: InternalRestClient,
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
  }

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

  /**
   * Muro de cámaras EN VIVO: emite un token solo-suscripción de la cabina de un viaje en curso.
   * AUDITA ANTES de mintear (fail-closed estricto): si el audit falla, no se emite token — ningún
   * visionado de vigilancia queda sin registro (Ley 29733). El motivo es obligatorio. La doble-auth
   * (Roles + MFA fresca) la imponen los guards del controller (acá y en media-service).
   */
  async issueLiveToken(identity: AuthenticatedUser, dto: LiveAccessDto): Promise<LiveViewerToken> {
    // AUTORIZA server-side ANTES de auditar/mintear: solo cabinas de viajes EN CURSO (mismo gate que el
    // grant del pasajero/familia, public-bff). La UI solo lista IN_PROGRESS, pero eso es presentación —
    // la autoridad es esta verificación (un admin no puede mintear un token para un viaje arbitrario por
    // API directa). NO se bloquea el pánico: el admin/compliance es el RESPONDEDOR (el panel existe para eso),
    // a diferencia de la familia (a quien sí se le oculta, por si un atacante mira el enlace).
    const meta = grpcIdentityMetadata(identity, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: dto.tripId }, meta);
    if (!trip.found) throw new NotFoundException('Viaje no encontrado');
    // Status crudo del gRPC → contrato; fuera del contrato (null) = fail-closed. La política
    // (solo viaje en curso) vive en el predicado de dominio compartido por los 3 BFFs.
    const status = normalizeTripStatus(trip.status);
    if (status === null || !canAccessLiveCabin(status)) {
      throw new ForbiddenException('La cámara en vivo solo está disponible durante un viaje en curso');
    }
    await this.audit.record(identity, {
      action: 'media.live_access',
      resourceType: 'media_live',
      resourceId: dto.tripId,
      payload: { tripId: dto.tripId, reason: dto.reason },
    });
    // `name` = identidad visible del operador en la room (accountability), derivada de la sesión, no del cliente.
    return this.rest.post<LiveViewerToken>(`/media/rooms/${dto.tripId}/viewer-token`, {
      identity,
      body: { name: `admin-${identity.userId}` },
    });
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
