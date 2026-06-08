/**
 * OpsService — operación: listados (read-model), detalle agregado de viaje (gRPC fan-out) y
 * aprobaciones de conductores/operadores (REST interno firmado + auditoría).
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalRestClient, type GrpcServiceClient } from '@veo/rpc';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser as AuthUser } from '@veo/auth';
import type { TripSummary, DriverSummary } from '@veo/api-client';
import {
  GRPC_TRIP,
  GRPC_IDENTITY,
  GRPC_RATING,
  REST_IDENTITY,
} from '../infra/tokens';
import { grpcIdentityMeta } from '../infra/grpc-identity';
import { ReadModelService, type Page } from '../read-model/read-model.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';
import { tripRecordToSummary, driverRecordToSummary, mapTripStatus } from './mappers';
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
  found: boolean;
}
interface UserReply {
  id: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
}
interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
}
interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string;
  found: boolean;
}

export interface TripDetailView {
  trip: {
    id: string;
    status: string;
    passengerId: string;
    driverId: string | null;
    vehicleId: string | null;
    fareCents: number;
    currency: string;
    distanceMeters: number;
    durationSeconds: number;
    paymentMethod: string;
    childMode: boolean;
    penaltyCents: number;
  };
  passenger: { id: string; type: string; kycStatus: string } | null;
  driver: { id: string; userId: string; status: string; backgroundCheckStatus: string; averageRating: number | null } | null;
  /** Derivado del propio viaje: no hay lookup de pago por tripId en el downstream (ver reporte de huecos). */
  payment: { method: string; fareCents: number; currency: string } | null;
  rating: { rollingAvg30d: number; count30d: number; flagged: boolean; flagReason: string | null } | null;
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
    @Inject(GRPC_RATING) private readonly ratingGrpc: GrpcServiceClient,
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

  async listDrivers(query: ListDriversQueryDto): Promise<Page<DriverSummary>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await this.readModel.listDrivers({ status: query.status }, query.cursor ?? null, limit);
    return { items: page.items.map(driverRecordToSummary), nextCursor: page.nextCursor };
  }

  /** Detalle agregado: trip (gRPC) + passenger + driver + rating; payment derivado del trip. */
  async tripDetail(identity: AuthUser, tripId: string): Promise<TripDetailView> {
    const meta = grpcIdentityMeta(identity, this.secret);
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

    const rating = trip.driverId
      ? await this.ratingGrpc
          .call<AggregateReply>('GetAggregate', { subjectId: trip.driverId }, meta)
          .catch(() => null)
      : null;

    return {
      trip: {
        id: trip.id,
        status: mapTripStatus(trip.status),
        passengerId: trip.passengerId,
        driverId: trip.driverId || null,
        vehicleId: trip.vehicleId || null,
        fareCents: trip.fareCents,
        currency: trip.currency,
        distanceMeters: trip.distanceMeters,
        durationSeconds: trip.durationSeconds,
        paymentMethod: trip.paymentMethod,
        childMode: trip.childMode,
        penaltyCents: trip.penaltyCents,
      },
      passenger: passenger?.found
        ? { id: passenger.id, type: passenger.type, kycStatus: passenger.kycStatus }
        : null,
      driver: driver?.found
        ? {
            id: driver.id,
            userId: driver.userId,
            status: driver.currentStatus,
            backgroundCheckStatus: driver.backgroundCheckStatus,
            averageRating: driver.averageRating || null,
          }
        : null,
      payment: { method: trip.paymentMethod, fareCents: trip.fareCents, currency: trip.currency },
      rating: rating?.found
        ? {
              rollingAvg30d: rating.rollingAvg30d,
              count30d: rating.count30d,
              flagged: rating.flagged,
              flagReason: rating.flagReason || null,
            }
          : null,
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
