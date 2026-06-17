/**
 * MediaService — acceso a video con doble-auth (BR-S07): un operador SOLICITA y otro APRUEBA con
 * step-up MFA fresco. El stream devuelve una URL firmada con watermark. Todo se audita.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient, type GrpcServiceClient, type TripReply } from '@veo/rpc';
import { grpcIdentityMetadata, type AuthenticatedUser } from '@veo/auth';
import { ForbiddenError, NotFoundError } from '@veo/utils';
import { canAccessLiveCabin, normalizeTripStatus } from '@veo/api-client';
import { GRPC_TRIP, REST_MEDIA } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import type { LiveAccessDto, RequestAccessDto, VideoAccessStatus } from './dto/media.dto';

/** Respuesta mínima de media-service al crear una solicitud (POST /media/access). */
interface AccessRequestCreated {
  id: string;
  status: VideoAccessStatus;
}

/**
 * Registro completo de una solicitud de acceso a video tal como lo expone media-service
 * (GET/approve/reject). Es el modelo aguas-abajo que el bff mapea a la vista del cliente.
 */
interface VideoAccessRequest {
  id: string;
  segmentId: string | null;
  tripId: string;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: VideoAccessStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  signedUrlExpiresAt: string | null;
  watermark: string | null;
  createdAt: string;
}

/** Stream firmado que devuelve media-service (GET .../stream). */
interface StreamReply {
  signedUrl: string;
  watermark: string;
  expiresAt: string;
  segmentId: string;
}

/** Vista de solicitud de acceso que consume admin-web (schema Zod `mediaAccessRequestView`). */
export interface MediaAccessRequestView {
  id: string;
  tripId: string;
  requestedBy: string;
  reason: string;
  status: VideoAccessStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** URL firmada del video que consume admin-web (schema Zod `signedMedia`). */
export interface SignedMedia {
  url: string;
  expiresAt: string;
  watermark: string;
}

/** Token de cámara EN VIVO (solo-suscripción) emitido por media-service para el muro del admin. */
export interface LiveViewerToken {
  roomName: string;
  token: string;
  url: string;
  expiresInSeconds: number;
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

/**
 * Mapea el registro completo de media-service a la vista del cliente (contrato EXACTO validado por Zod).
 * `decidedAt`/`decidedBy` colapsan la rama approve/reject en un solo campo (la que esté presente, o null).
 */
function toView(req: VideoAccessRequest): MediaAccessRequestView {
  return {
    id: req.id,
    tripId: req.tripId,
    requestedBy: req.requestedBy,
    reason: req.reason,
    status: req.status,
    requestedAt: req.createdAt,
    decidedAt: req.approvedAt ?? req.rejectedAt ?? null,
    decidedBy: req.approvedBy ?? req.rejectedBy ?? null,
  };
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

  /**
   * Email del operador para incrustar como watermark en el video (media-service lo exige con @IsEmail).
   * El JWT admin transporta el `email` del operador (claim solo-admin, staff interno), así que el
   * watermark muestra la identidad legible REAL del operador (BR-S02), no un sintético opaco. El camino
   * de REFRESH de identity ahora distingue sujeto admin (`typ:'admin'` en el refresh token) y REPUEBLA
   * `email` (y roles) desde AdminUser, así que el token re-emitido por refresh TAMBIÉN porta el email.
   *
   * Fallback residual: solo se activa para identidades sin email (passenger/driver, que nunca acceden a
   * este BFF) o un refresh token PREVIO al fix que aún no portaba `typ` y se re-emitió sin email; en ese
   * caso caemos al email determinista derivado del `userId` —que ES la clave canónica de rendición de
   * cuentas (mismo valor que media-service persiste como `requestedBy`/`approvedBy`)— para que la
   * validación @IsEmail downstream no rompa. Tras el primer refresh, el token queda curado con `typ` y
   * el email real vuelve a estar presente.
   */
  private operatorEmail(identity: AuthenticatedUser): string {
    return identity.email ?? `${identity.userId}@operator.veo.internal`;
  }

  /** Lista las solicitudes de acceso (opcionalmente filtradas por estado). Lectura — solo rol, sin step-up. */
  async listRequests(
    identity: AuthenticatedUser,
    status?: VideoAccessStatus,
  ): Promise<MediaAccessRequestView[]> {
    const res = await this.rest.get<VideoAccessRequest[]>('/media/access', {
      identity,
      query: { status },
    });
    return res.map(toView);
  }

  /**
   * Crea una solicitud de acceso (queda PENDING). El `operatorEmail` se deriva de la sesión, NO del cliente.
   * media-service devuelve solo {id,status}; construimos la vista con los datos conocidos (el cliente igual
   * invalida y refetchea la lista real, así que la vista provisional alcanza para el optimistic update).
   */
  async requestAccess(
    identity: AuthenticatedUser,
    dto: RequestAccessDto,
  ): Promise<MediaAccessRequestView> {
    const created = await this.rest.post<AccessRequestCreated>('/media/access', {
      identity,
      body: { tripId: dto.tripId, reason: dto.reason, operatorEmail: this.operatorEmail(identity) },
    });
    await this.audit.record(identity, {
      action: 'media.access_request',
      resourceType: 'media_access',
      resourceId: created.id,
      payload: { tripId: dto.tripId, reason: dto.reason },
    });
    return {
      id: created.id,
      tripId: dto.tripId,
      requestedBy: identity.userId,
      reason: dto.reason,
      status: created.status,
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
  }

  /** Aprueba la solicitud (requiere MFA fresca; el controller lo impone). Audita la decisión. */
  async approveRequest(
    identity: AuthenticatedUser,
    requestId: string,
  ): Promise<MediaAccessRequestView> {
    const res = await this.rest.post<VideoAccessRequest>(`/media/access/${requestId}/approve`, {
      identity,
    });
    await this.audit.record(identity, {
      action: 'media.access_approve',
      resourceType: 'media_access',
      resourceId: requestId,
      payload: { tripId: res.tripId, status: res.status },
    });
    return toView(res);
  }

  /** Rechaza la solicitud (solo rol, sin step-up). Audita la decisión. */
  async rejectRequest(
    identity: AuthenticatedUser,
    requestId: string,
  ): Promise<MediaAccessRequestView> {
    const res = await this.rest.post<VideoAccessRequest>(`/media/access/${requestId}/reject`, {
      identity,
    });
    await this.audit.record(identity, {
      action: 'media.access_reject',
      resourceType: 'media_access',
      resourceId: requestId,
      payload: { tripId: res.tripId, status: res.status },
    });
    return toView(res);
  }

  /**
   * Obtiene la URL firmada del video de una solicitud aprobada (requiere MFA fresca; el controller lo impone).
   * El acceso efectivo al material sensible se audita ANTES de devolver la URL (fail-closed, Ley 29733).
   */
  async streamRequest(identity: AuthenticatedUser, requestId: string): Promise<SignedMedia> {
    const res = await this.rest.get<StreamReply>(`/media/access/${requestId}/stream`, { identity });
    await this.audit.record(identity, {
      action: 'media.access_stream',
      resourceType: 'media_access',
      resourceId: requestId,
      payload: { segmentId: res.segmentId, expiresAt: res.expiresAt },
    });
    return { url: res.signedUrl, expiresAt: res.expiresAt, watermark: res.watermark };
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
    if (!trip.found) throw new NotFoundError('Viaje no encontrado');
    // Status crudo del gRPC → contrato; fuera del contrato (null) = fail-closed. La política
    // (solo viaje en curso) vive en el predicado de dominio compartido por los 3 BFFs.
    const status = normalizeTripStatus(trip.status);
    if (status === null || !canAccessLiveCabin(status)) {
      throw new ForbiddenError('La cámara en vivo solo está disponible durante un viaje en curso');
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
    // requestAccess/streamRequest. fail-closed: si el audit falla, el listado falla.
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
