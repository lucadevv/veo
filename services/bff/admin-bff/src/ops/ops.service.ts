/**
 * OpsService — operación: listados (read-model), detalle agregado de viaje (gRPC fan-out) y
 * aprobaciones de conductores/operadores (REST interno firmado + auditoría).
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalRestClient,
  type GrpcServiceClient,
  type TripReply,
  type UserReply,
  type DriverReply,
  type DriverVehiclesReply,
  type DriverDocumentsReply,
} from '@veo/rpc';
import { ConflictError, ForbiddenError, NotFoundError } from '@veo/utils';
import { grpcIdentityMetadata, type AuthenticatedUser as AuthUser } from '@veo/auth';
import {
  canGrantRoles,
  FleetDocumentType,
  FleetDocumentStatus,
  type AdminRole,
} from '@veo/shared-types';
import type {
  TripSummary,
  DriverApproval,
  TripDetail,
  DriverDetail,
  AdminDriverDocument,
  GeoPoint,
} from '@veo/api-client';
import { GRPC_TRIP, GRPC_IDENTITY, GRPC_FLEET, REST_IDENTITY, REST_MEDIA } from '../infra/tokens';
import { ReadModelService, type Page } from '../read-model/read-model.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import { tripRecordToSummary, driverRecordToApproval, mapTripStatus } from './mappers';
import {
  canSeeIdentity,
  canSeePlate,
  canSeeExactTripGeo,
  maskPlate,
  coarseGeo,
} from '../redaction/redaction.policy';
import type { ListTripsQueryDto, ListDriversQueryDto } from './dto/ops.dto';

const DEFAULT_LIMIT = 25;

/**
 * Documentos OBLIGATORIOS para aprobar a un conductor (gate server-side autoritativo · Ley 29733).
 * Tipos del enum canónico de flota (NO magic strings): licencia A1 + SOAT + tarjeta de propiedad.
 * DEUDA: el onboarding móvil sube LICENSE_A1 + SOAT + 'VEHICLE_REGISTRATION', pero el enum canónico de
 * fleet para la tarjeta de propiedad del vehículo es PROPERTY_CARD — hay un mismatch de string a
 * reconciliar (mobile 'VEHICLE_REGISTRATION' ↔ fleet PROPERTY_CARD). Acá mandamos el tipo canónico.
 */
const REQUIRED_DRIVER_DOC_TYPES = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
] as const;

/** proto3 entrega "" para strings ausentes; el contrato del panel los quiere `null` honesto. */
function emptyToNull(s: string): string | null {
  return s ? s : null;
}

/** Coords del proto (lng) → GeoPoint (lon); 0,0 (default proto3 = sin set) → null honesto. */
function toGeo(lat: number, lng: number): GeoPoint | null {
  if (!lat && !lng) return null;
  return { lat, lon: lng };
}

export interface PendingDriver {
  id: string;
  userId: string;
  licenseNumber: string | null;
}
export interface OperatorSummary {
  id: string;
  email: string;
  status: string;
  roles: string[];
  createdAt: string;
}

export interface CreatedOperator {
  id: string;
  inviteToken: string;
  inviteUrl: string;
  expiresAt: string;
}

@Injectable()
export class OpsService {
  private readonly secret: string;
  private readonly documentsBucket: string;

  constructor(
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
    @Inject(REST_MEDIA) private readonly mediaRest: InternalRestClient,
    private readonly readModel: ReadModelService,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
    this.documentsBucket = config.get('S3_BUCKET_DOCUMENTS', { infer: true });
  }

  async listTrips(roles: AdminRole[], query: ListTripsQueryDto): Promise<Page<TripSummary>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listTrips(
      { status: query.status, driverId: query.driverId, passengerId: query.passengerId },
      query.cursor ?? null,
      limit,
    );
    return {
      items: page.items.map((r) => tripRecordToSummary(r, roles)),
      nextCursor: page.nextCursor,
    };
  }

  async listDrivers(roles: AdminRole[], query: ListDriversQueryDto): Promise<Page<DriverApproval>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listDrivers(
      { status: query.status },
      query.cursor ?? null,
      limit,
    );
    return {
      items: page.items.map((r) => driverRecordToApproval(r, roles)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Detalle de viaje al contrato PLANO `tripDetail` (@veo/api-client). Enriquece con datos REALES del
   * fan-out gRPC: createdAt←requestedAt, origin/destination de coords, nombres de identity. Lo que GetTrip
   * NO provee (ubicación EN VIVO del conductor, ETA, polilínea de ruta, placa del vehículo, timeline de
   * eventos) va `null`/`[]` honesto — su enriquecimiento (tracking/fleet/trip-events) es follow-up.
   */
  async tripDetail(identity: AuthUser, tripId: string): Promise<TripDetail> {
    const meta = grpcIdentityMetadata(identity, this.secret);
    const trip = await this.tripGrpc.call<TripReply>('GetTrip', { id: tripId }, meta);
    if (!trip.found) throw new NotFoundError('Viaje no encontrado', { tripId });

    const [passenger, driver, vehicles] = await Promise.all([
      trip.passengerId
        ? this.identityGrpc
            .call<UserReply>('GetUser', { id: trip.passengerId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      trip.driverId
        ? this.identityGrpc
            .call<DriverReply>('GetDriver', { id: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
      // Placa del vehículo del conductor (fleet): best-effort, no debe tumbar el detalle si fleet falla.
      trip.driverId
        ? this.fleetGrpc
            .call<DriverVehiclesReply>('GetDriverVehicles', { id: trip.driverId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    // Un conductor puede tener varios vehículos: priorizamos el ACTIVO, si no el primero.
    const rawPlate =
      vehicles?.vehicles?.find((v) => v.active)?.plate ?? vehicles?.vehicles?.[0]?.plate ?? null;

    // REDACCIÓN PII (server-side, matriz aprobada): identidad=Compliance+, placa=dispatch+ (SUPPORT
    // → enmascarada), geo de viaje=dispatch+ (SUPPORT → coarse ~100m). Montos (fareCents) NO se
    // redactan acá: el contrato lo declara `number` no-nullable → diferido (ver mappers.ts + reporte).
    const roles = identity.roles;
    const passengerName = passenger?.found ? passenger.name || null : null;
    const driverName = driver?.found ? driver.name || null : null;
    const origin = toGeo(trip.originLat, trip.originLng);
    const destination = toGeo(trip.destinationLat, trip.destinationLng);

    return {
      id: trip.id,
      status: mapTripStatus(trip.status),
      passengerId: trip.passengerId,
      driverId: trip.driverId || null,
      fareCents: trip.fareCents,
      createdAt: trip.requestedAt,
      origin: canSeeExactTripGeo(roles) ? origin : coarseGeo(origin),
      destination: canSeeExactTripGeo(roles) ? destination : coarseGeo(destination),
      driverLocation: null, // dato EN VIVO (tracking-service), no en GetTrip
      routePolyline: null, // follow-up: ruta no expuesta por GetTrip
      etaSeconds: null, // dato EN VIVO
      distanceMeters: trip.distanceMeters || null,
      passengerName: canSeeIdentity(roles) ? passengerName : null,
      driverName: canSeeIdentity(roles) ? driverName : null,
      // Fecha de suspensión del conductor (proto DriverReply.suspendedAt; '' = no suspendido → null).
      driverSuspendedAt: driver?.found ? driver.suspendedAt || null : null,
      vehiclePlate: canSeePlate(roles) ? rawPlate : maskPlate(rawPlate),
      paymentMethod: trip.paymentMethod || null,
      timeline: [], // follow-up: timeline de eventos no expuesta por GetTrip
    };
  }

  // ── Conductores ──

  /**
   * Detalle de revisión de un conductor (GET /ops/drivers/:id): datos core + estado biométrico +
   * documentos con URLs GET firmadas. Fan-out gRPC (identity GetDriver + fleet GetDriverDocuments) en
   * paralelo; por cada doc con archivo, acuña una presigned URL contra media-service. Auditado (Ley
   * 29733: ver PII/documentos del conductor deja traza inmutable). Ruta gateada a Compliance+ (toda esa
   * franja pasa canSeeIdentity → no se enmascara nada acá: el operador ve los datos completos para revisar).
   */
  async driverDetail(identity: AuthUser, driverId: string): Promise<DriverDetail> {
    const meta = grpcIdentityMetadata(identity, this.secret);
    const [driver, docs] = await Promise.all([
      this.identityGrpc.call<DriverReply>('GetDriver', { id: driverId }, meta),
      this.fleetGrpc.call<DriverDocumentsReply>('GetDriverDocuments', { id: driverId }, meta),
    ]);
    if (!driver.found) throw new NotFoundError('Conductor no encontrado', { driverId });

    // Por cada documento: si tiene archivo (fileS3Key no vacío) acuñamos una presigned GET URL contra
    // media-service. fileS3Key '' = todavía no se subió archivo (estado real actual — DEUDA: el upload
    // del archivo del documento no está implementado) → url null. Las firmas van en paralelo.
    const documents: AdminDriverDocument[] = await Promise.all(
      docs.documents.map(async (doc) => ({
        id: doc.id,
        type: doc.type as AdminDriverDocument['type'],
        status: doc.status as AdminDriverDocument['status'],
        expiresAt: emptyToNull(doc.expiresAt),
        rejectionReason: emptyToNull(doc.rejectionReason),
        url: await this.presignDocument(identity, doc.fileS3Key),
      })),
    );

    await this.audit.record(identity, {
      action: 'driver.documents.view',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { documentCount: documents.length },
    });

    return {
      id: driver.id,
      userId: driver.userId,
      fullName: emptyToNull(driver.name),
      phone: emptyToNull(driver.phone),
      licenseNumber: emptyToNull(driver.licenseNumber),
      backgroundCheckStatus: driver.backgroundCheckStatus,
      kycStatus: driver.kycStatus,
      currentStatus: driver.currentStatus,
      // createdAt es no-nullable en el contrato; proto3 entrega "" si no hay dato → degradación honesta a "".
      createdAt: driver.createdAt,
      rejectionReason: emptyToNull(driver.rejectionReason),
      biometric: {
        faceEnrolledAt: emptyToNull(driver.faceEnrolledAt),
        lastVerifiedAt: emptyToNull(driver.lastVerifiedAt),
      },
      documents,
    };
  }

  /**
   * Acuña una presigned GET URL para el archivo de un documento (media-service, server-to-server).
   * fileS3Key '' (sin archivo subido aún) → null. FAIL-SOFT: si la firma falla, devolvemos null y
   * seguimos — una clave inválida NO debe tumbar toda la pantalla de revisión (la decisión de aprobar
   * NO depende de poder ver el archivo; el gate de aprobación valida el ESTADO del doc, no su URL).
   */
  private async presignDocument(identity: AuthUser, fileS3Key: string): Promise<string | null> {
    if (!fileS3Key) return null;
    try {
      const { url } = await this.mediaRest.post<{ url: string }>('/media/internal/presign-get', {
        identity,
        body: { bucket: this.documentsBucket, key: fileS3Key, ttlSeconds: 120 },
      });
      return url;
    } catch {
      return null;
    }
  }

  async listPendingDrivers(identity: AuthUser): Promise<PendingDriver[]> {
    const list = await this.identityRest.get<PendingDriver[]>('/drivers/pending-approval', {
      identity,
    });
    // licenseNumber (DNI/licencia) = IDENTIDAD personal → Compliance+. Sub-Compliance: null honesto.
    if (canSeeIdentity(identity.roles)) return list;
    return list.map((d) => ({ ...d, licenseNumber: null }));
  }

  async approveDriver(
    identity: AuthUser,
    driverId: string,
  ): Promise<{ id: string; backgroundCheckStatus: string }> {
    // GATE autoritativo server-side (NO depende de la UI): un conductor solo se aprueba si TODOS los
    // documentos obligatorios existen con estado VALID. Ley 29733: la decisión de habilitar un conductor
    // exige documentación válida verificable. Corta ANTES de delegar la aprobación a identity-service.
    const meta = grpcIdentityMetadata(identity, this.secret);
    const docs = await this.fleetGrpc.call<DriverDocumentsReply>(
      'GetDriverDocuments',
      { id: driverId },
      meta,
    );
    const missing = REQUIRED_DRIVER_DOC_TYPES.filter(
      (req) =>
        !docs.documents.some((d) => d.type === req && d.status === FleetDocumentStatus.VALID),
    );
    if (missing.length > 0) {
      throw new ConflictError(
        `No se puede aprobar: faltan documentos válidos (${missing.join(', ')})`,
        { driverId, missing },
      );
    }

    const res = await this.identityRest.post<{ id: string; backgroundCheckStatus: string }>(
      `/drivers/${driverId}/approve`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'driver.approve',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { backgroundCheckStatus: res.backgroundCheckStatus },
    });
    return res;
  }

  async rejectDriver(identity: AuthUser, driverId: string, reason?: string): Promise<void> {
    // El motivo (si lo hay) viaja al identity-service, que lo persiste y emite driver.rejected.
    await this.identityRest.post<void>(`/drivers/${driverId}/reject`, {
      identity,
      body: reason ? { reason } : undefined,
    });
    await this.audit.record(identity, {
      action: 'driver.reject',
      resourceType: 'driver',
      resourceId: driverId,
      // El motivo queda en la traza inmutable junto a la decisión (sin motivo ⇒ se omite la clave).
      ...(reason ? { payload: { reason } } : {}),
    });
  }

  async suspendDriver(identity: AuthUser, driverId: string, reason: string): Promise<void> {
    // El motivo viaja al identity-service, que escribe suspendedAt (CAS idempotente) y emite driver.suspended.
    await this.identityRest.post<void>(`/drivers/${driverId}/suspend`, {
      identity,
      body: { reason },
    });
    await this.audit.record(identity, {
      action: 'driver.suspend',
      resourceType: 'driver',
      resourceId: driverId,
      // El motivo queda en la traza inmutable junto a la decisión del operador (SAFETY).
      payload: { reason },
    });
  }

  // ── Operadores ──

  listOperators(identity: AuthUser): Promise<OperatorSummary[]> {
    return this.identityRest.get<OperatorSummary[]>('/admin/operators', { identity });
  }

  async createOperator(
    identity: AuthUser,
    email: string,
    roles: AdminRole[],
  ): Promise<CreatedOperator> {
    // Anti-escalada: el actor solo otorga roles de rango ESTRICTAMENTE menor al suyo
    // (excepción: SUPERADMIN→SUPERADMIN). El detalle estructurado va al log/audit, no al body.
    if (!canGrantRoles(identity.roles, roles)) {
      throw new ForbiddenError('No podés otorgar un rol de rango igual o superior al tuyo', {
        actorRoles: identity.roles,
        requested: roles,
      });
    }
    const res = await this.identityRest.post<CreatedOperator>('/admin/operators', {
      identity,
      body: { email, roles },
    });
    await this.audit.record(identity, {
      action: 'operator.create',
      resourceType: 'admin_user',
      resourceId: res.id,
      payload: { email, roles },
    });
    return res;
  }

  async reinviteOperator(
    identity: AuthUser,
    operatorId: string,
  ): Promise<{ inviteUrl: string; expiresAt: string }> {
    const res = await this.identityRest.post<{ inviteUrl: string; expiresAt: string }>(
      `/admin/operators/${operatorId}/reinvite`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'operator.reinvite',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
    return res;
  }

  async rejectOperator(identity: AuthUser, operatorId: string): Promise<void> {
    await this.identityRest.post<void>(`/admin/operators/${operatorId}/reject`, { identity });
    await this.audit.record(identity, {
      action: 'operator.reject',
      resourceType: 'admin_user',
      resourceId: operatorId,
    });
  }
}
