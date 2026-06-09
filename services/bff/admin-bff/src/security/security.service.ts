/**
 * SecurityService — incidentes de pánico: listado/detalle (panic-service tiene listado real),
 * acknowledge/resolve/evidence (REST interno firmado). Toda acción sensible se audita.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient, type GrpcServiceClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PanicSummary, PanicDetail } from '@veo/api-client';
import { GRPC_IDENTITY, GRPC_TRIP, REST_PANIC } from '../infra/tokens';
import { grpcIdentityMeta } from '../infra/grpc-identity';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import type { ListPanicsQueryDto, ResolvePanicDto, PanicEvidenceDto } from './dto/panic.dto';

/** Página con cursor; misma forma que `paginated()` del contrato admin-web. */
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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
  resolvedAt?: string;
}
/** Replies gRPC mínimas para enriquecer nombres (mismo contrato que ops.service). */
interface UserReply {
  name: string;
  found: boolean;
}
interface DriverReply {
  name: string;
  found: boolean;
}
interface TripReply {
  driverId: string;
  found: boolean;
}

@Injectable()
export class SecurityService {
  private readonly secret: string;

  constructor(
    @Inject(REST_PANIC) private readonly rest: InternalRestClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  async listPanics(identity: AuthenticatedUser, query: ListPanicsQueryDto): Promise<Page<PanicSummary>> {
    const list = await this.rest.get<PanicEntity[]>('/panic', { identity, query: { status: query.status } });
    // panic-service devuelve un array; el contrato admin es paginado. Sin cursor downstream → nextCursor null.
    return { items: list.map(toPanicSummary), nextCursor: null };
  }

  async getPanic(identity: AuthenticatedUser, id: string): Promise<PanicDetail> {
    const p = await this.rest.get<PanicEntity>(`/panic/${id}`, { identity });
    return this.enrichPanicDetail(identity, p);
  }

  async ack(identity: AuthenticatedUser, id: string): Promise<PanicDetail> {
    const p = await this.rest.post<PanicEntity>(`/panic/${id}/ack`, { identity });
    await this.audit.record(identity, { action: 'panic.ack', resourceType: 'panic', resourceId: id });
    return this.enrichPanicDetail(identity, p);
  }

  /**
   * Enriquece el detalle con NOMBRES reales (security: quién está en peligro / quién maneja). PanicEntity
   * no trae driverId → se resuelve por el viaje (GetTrip), y los nombres por identity (GetUser/GetDriver).
   * fail-safe: si cualquier lookup cae, degrada a null (el detalle de pánico NUNCA debe romperse).
   */
  private async enrichPanicDetail(identity: AuthenticatedUser, p: PanicEntity): Promise<PanicDetail> {
    const base = toPanicDetail(p);
    const meta = grpcIdentityMeta(identity, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: p.tripId }, meta).catch(() => null);
    const driverId = trip?.found ? trip.driverId || null : null;
    const [passenger, driver] = await Promise.all([
      this.identityGrpc.call<UserReply>('GetUser', { id: p.passengerId }, meta).catch(() => null),
      driverId
        ? this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      ...base,
      passengerName: passenger?.found ? passenger.name || null : null,
      driverId,
      driverName: driver?.found ? driver.name || null : null,
    };
  }

  async resolve(identity: AuthenticatedUser, id: string, dto: ResolvePanicDto): Promise<PanicDetail> {
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
    return this.enrichPanicDetail(identity, p);
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

/** Detalle del pánico al contrato. Los nombres (passenger/driver) y notes no los provee panic-service →
 *  null honesto (no data falsa); el enriquecimiento por identity/trip es follow-up. evidence: se mapean
 *  los S3 keys a objetos mostrables (kind por extensión, label = nombre de archivo, at = inicio del incidente). */
function toPanicDetail(p: PanicEntity): PanicDetail {
  return {
    id: p.id,
    tripId: p.tripId,
    passengerId: p.passengerId,
    passengerName: null,
    driverId: null,
    driverName: null,
    status: p.status,
    geo: p.geoPoint,
    triggeredAt: p.triggeredAt,
    acknowledgedAt: p.acknowledgedAt ?? null,
    resolvedAt: p.resolvedAt ?? null,
    acknowledgedBy: p.ackBy ?? null,
    notes: null,
    evidence: (p.evidenceS3Keys ?? []).map((key) => ({
      id: key,
      kind: evidenceKind(key),
      label: key.split('/').pop() ?? key,
      at: p.triggeredAt,
    })),
  };
}

/** Tipo de evidencia derivado de la extensión del S3 key (dato real, no inventado). */
function evidenceKind(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'photo';
  if (['mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'file';
}
