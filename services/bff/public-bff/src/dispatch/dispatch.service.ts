/**
 * Lectura de surge (multiplicador dinámico) vía gRPC dispatch GetSurge.
 */
import { Inject, Injectable } from '@nestjs/common';
import { GrpcServiceClient } from '@veo/rpc';
import { grpcIdentityMetadata, INTERNAL_IDENTITY_SECRET, type AuthenticatedUser } from '@veo/auth';
import { GRPC_DISPATCH } from '../infra/downstream.tokens';
import type { NearbyDriversReply, SurgeReply } from '../infra/grpc-types';
import { type SurgeView } from './dto/surge-query.dto';
import { type NearbyVehiclesView } from './dto/nearby-query.dto';

@Injectable()
export class DispatchService {
  constructor(
    @Inject(GRPC_DISPATCH) private readonly dispatchGrpc: GrpcServiceClient,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  async getSurge(user: AuthenticatedUser, lat: number, lon: number): Promise<SurgeView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.dispatchGrpc.call<SurgeReply>('GetSurge', { lat, lon }, meta);
    return { multiplier: reply.multiplier, zoneId: reply.zoneId, active: reply.active };
  }

  /**
   * Feed de conductores cercanos ANÓNIMOS para el mapa del pasajero. Reenvía a dispatch GetNearbyDrivers
   * y reproyecta a {lat,lon,vehicleType}: el reply gRPC ya viene sin driverId, y este DTO tampoco lo
   * declara — privacidad por construcción (seguridad = diferenciador VEO).
   */
  async getNearby(
    user: AuthenticatedUser,
    lat: number,
    lon: number,
    vehicleType?: string,
  ): Promise<NearbyVehiclesView> {
    const meta = grpcIdentityMetadata(user, this.secret);
    const reply = await this.dispatchGrpc.call<NearbyDriversReply>(
      'GetNearbyDrivers',
      { lat, lon, vehicleType: vehicleType ?? '' },
      meta,
    );
    return {
      vehicles: reply.drivers.map((d) => ({ lat: d.lat, lon: d.lon, vehicleType: d.vehicleType })),
    };
  }
}
