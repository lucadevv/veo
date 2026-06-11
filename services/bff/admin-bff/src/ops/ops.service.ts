/**
 * OpsService — operación: listados (read-model), detalle agregado de viaje (gRPC fan-out) y
 * aprobaciones de conductores/operadores (REST interno firmado + auditoría).
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient, type GrpcServiceClient } from '@veo/rpc';
import { NotFoundError } from '@veo/utils';
import { grpcIdentityMetadata, type AuthenticatedUser as AuthUser } from '@veo/auth';
import type { TripSummary, DriverApproval, TripDetail, GeoPoint } from '@veo/api-client';
import {
  GRPC_TRIP,
  GRPC_IDENTITY,
  REST_IDENTITY,
} from '../infra/tokens';
import { ReadModelService, type Page } from '../read-model/read-model.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import { tripRecordToSummary, driverRecordToApproval, mapTripStatus } from './mappers';
import type { ListTripsQueryDto, ListDriversQueryDto } from './dto/ops.dto';

const DEFAULT_LIMIT = 25;

interface TripReply {
  id: string;
  passengerId: string;
  driverId: string;
  vehicleId: string;
  status: string;
  fareCents: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  // Enriquecimiento del detalle (proto TripReply): timestamp real + coords de origen/destino.
  requestedAt: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  found: boolean;
}
interface UserReply {
  id: string;
  type: string;
  kycStatus: string;
  name: string; // proto UserReply.name (de User.name); '' si no registrado.
  deleted: boolean;
  found: boolean;
}
interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  name: string; // proto DriverReply.name (de User.name vía driver→user); '' si no registrado.
  found: boolean;
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
export interface PendingOperator {
  id: string;
  email: string;
  createdAt: string;
}

@Injectable()
export class OpsService {
  private readonly secret: string;

  constructor(
    @Inject(GRPC_TRIP) private readonly tripGrpc: GrpcServiceClient,
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(REST_IDENTITY) private readonly identityRest: InternalRestClient,
    private readonly readModel: ReadModelService,
    private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  async listTrips(query: ListTripsQueryDto): Promise<Page<TripSummary>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listTrips(
      { status: query.status, driverId: query.driverId, passengerId: query.passengerId },
      query.cursor ?? null,
      limit,
    );
    return { items: page.items.map(tripRecordToSummary), nextCursor: page.nextCursor };
  }

  async listDrivers(query: ListDriversQueryDto): Promise<Page<DriverApproval>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listDrivers({ status: query.status }, query.cursor ?? null, limit);
    return { items: page.items.map(driverRecordToApproval), nextCursor: page.nextCursor };
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

    const [passenger, driver] = await Promise.all([
      trip.passengerId
        ? this.identityGrpc.call<UserReply>('GetUser', { id: trip.passengerId }, meta).catch(() => null)
        : Promise.resolve(null),
      trip.driverId
        ? this.identityGrpc.call<DriverReply>('GetDriver', { id: trip.driverId }, meta).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      id: trip.id,
      status: mapTripStatus(trip.status),
      passengerId: trip.passengerId,
      driverId: trip.driverId || null,
      fareCents: trip.fareCents,
      createdAt: trip.requestedAt,
      origin: toGeo(trip.originLat, trip.originLng),
      destination: toGeo(trip.destinationLat, trip.destinationLng),
      driverLocation: null, // dato EN VIVO (tracking-service), no en GetTrip
      routePolyline: null, // follow-up: ruta no expuesta por GetTrip
      etaSeconds: null, // dato EN VIVO
      distanceMeters: trip.distanceMeters || null,
      passengerName: passenger?.found ? passenger.name || null : null,
      driverName: driver?.found ? driver.name || null : null,
      vehiclePlate: null, // follow-up: requiere lookup a fleet por vehicleId
      paymentMethod: trip.paymentMethod || null,
      timeline: [], // follow-up: timeline de eventos no expuesta por GetTrip
    };
  }

  // ── Conductores ──

  listPendingDrivers(identity: AuthUser): Promise<PendingDriver[]> {
    return this.identityRest.get<PendingDriver[]>('/drivers/pending-approval', { identity });
  }

  async approveDriver(identity: AuthUser, driverId: string): Promise<{ id: string; backgroundCheckStatus: string }> {
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

  async rejectDriver(identity: AuthUser, driverId: string): Promise<void> {
    await this.identityRest.post<void>(`/drivers/${driverId}/reject`, { identity });
    await this.audit.record(identity, {
      action: 'driver.reject',
      resourceType: 'driver',
      resourceId: driverId,
    });
  }

  // ── Operadores ──

  listPendingOperators(identity: AuthUser): Promise<PendingOperator[]> {
    return this.identityRest.get<PendingOperator[]>('/admin/operators/pending', { identity });
  }

  async approveOperator(
    identity: AuthUser,
    operatorId: string,
    roles: string[],
  ): Promise<{ id: string; status: string; roles: string[] }> {
    const res = await this.identityRest.post<{ id: string; status: string; roles: string[] }>(
      `/admin/operators/${operatorId}/approve`,
      { identity, body: { roles } },
    );
    await this.audit.record(identity, {
      action: 'operator.approve',
      resourceType: 'admin_user',
      resourceId: operatorId,
      payload: { roles },
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
