/**
 * Controlador gRPC de dispatch (paquete veo.dispatch.v1.DispatchService).
 * Lectura síncrona del match y del surge para otros servicios (trip-service).
 * Devuelve `found=false` en vez de lanzar, para que el llamante decida.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { isDomainError } from '@veo/utils';
import type { VehicleClass } from '@veo/shared-types';
import type { MatchReply, NearbyDriver, SurgeReply } from '@veo/rpc';
import { DispatchService } from '../dispatch/dispatch.service';
import { SurgeService } from '../dispatch/surge.service';
import { NearbyDriversService } from '../dispatch/nearby-drivers.service';

interface GetMatchRequest {
  matchId: string;
}
interface GetSurgeRequest {
  lat: number;
  lon: number;
}
interface GetNearbyDriversRequest {
  lat: number;
  lon: number;
  /** Vacío = todos los tipos; si viene, filtra (CAR/MOTO). */
  vehicleType?: string;
}
/** Contrato compartido, ESTRECHADO: la respuesta la construimos nosotros → clase canónica (ADR 013). */
interface NearbyDriverReply extends NearbyDriver {
  vehicleType: VehicleClass;
}
interface NearbyDriversReply {
  drivers: NearbyDriverReply[];
}

const EMPTY_MATCH: MatchReply = {
  id: '',
  tripId: '',
  driverId: '',
  score: 0,
  attempt: 0,
  surgeMultiplier: 1,
  outcome: '',
  offeredAt: '',
  respondedAt: '',
  found: false,
};

@Controller()
export class DispatchGrpcController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly surge: SurgeService,
    private readonly nearby: NearbyDriversService,
  ) {}

  @GrpcMethod('DispatchService', 'GetMatch')
  async getMatch({ matchId }: GetMatchRequest): Promise<MatchReply> {
    try {
      const m = await this.dispatch.getMatch(matchId);
      return {
        id: m.id,
        tripId: m.tripId,
        driverId: m.driverId,
        score: m.score,
        attempt: m.attempt,
        surgeMultiplier: m.surgeMultiplier,
        outcome: m.outcome,
        offeredAt: m.offeredAt,
        respondedAt: m.respondedAt ?? '',
        found: true,
      };
    } catch (err) {
      if (isDomainError(err)) return EMPTY_MATCH;
      throw err;
    }
  }

  @GrpcMethod('DispatchService', 'GetSurge')
  async getSurge({ lat, lon }: GetSurgeRequest): Promise<SurgeReply> {
    const q = await this.surge.quote({ lat, lon });
    return { multiplier: q.multiplier, zoneId: q.zoneId ?? '', active: q.active };
  }

  @GrpcMethod('DispatchService', 'GetNearbyDrivers')
  async getNearbyDrivers({ lat, lon, vehicleType }: GetNearbyDriversRequest): Promise<NearbyDriversReply> {
    // El service valida coords (dentro de Lima) y coacciona vehicleType al enum (inválido → todos):
    // el borde gRPC NO pasa por el ValidationPipe HTTP, así que la validación vive en el dominio.
    // proto3: un string no-seteado llega como '' (no undefined). Normalizamos ''/ausente → undefined
    // ("tipo no especificado = todos"). `.length` evita el cambio a `??`, que NO cubriría el '' de proto3.
    const drivers = await this.nearby.nearby({ lat, lon }, vehicleType?.length ? vehicleType : undefined);
    return { drivers: drivers.map((d) => ({ lat: d.lat, lon: d.lon, vehicleType: d.vehicleType })) };
  }
}
