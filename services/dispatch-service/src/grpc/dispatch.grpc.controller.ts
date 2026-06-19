/**
 * Controlador gRPC de dispatch (paquete veo.dispatch.v1.DispatchService).
 * Lectura síncrona del match y del surge para otros servicios (trip-service).
 * Devuelve `found=false` en vez de lanzar, para que el llamante decida.
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { isDomainError } from '@veo/utils';
import type { VehicleClass } from '@veo/shared-types';
import type { MatchReply, NearbyDriver, SurgeReply } from '@veo/rpc';
import { DispatchService } from '../dispatch/dispatch.service';
import { SurgeService } from '../dispatch/surge.service';
import { NearbyDriversService } from '../dispatch/nearby-drivers.service';
import type { Env } from '../config/env.schema';

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
  private readonly secret: string;

  constructor(
    private readonly dispatch: DispatchService,
    private readonly surge: SurgeService,
    private readonly nearby: NearbyDriversService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /**
   * Lectura del match para el driver-bff (getOffer). ANTI-IDOR #9: el driverId NO se confía del payload
   * ni se ignora — se DERIVA de la identidad interna FIRMADA que el BFF propaga en la metadata gRPC, y el
   * service hace el ownership-check con ESE driverId. Identidad inválida/ausente → UNAUTHENTICATED.
   * Un match ajeno o inexistente → NotFoundError → found=false (anti-enumeración: no se filtra existencia,
   * mismo criterio que CloseTripByPassenger en trip-service).
   */
  @GrpcMethod('DispatchService', 'GetMatch')
  async getMatch({ matchId }: GetMatchRequest, metadata: Metadata): Promise<MatchReply> {
    const identity = verifyGrpcIdentity(metadata, this.secret, {
      allowedAudiences: this.allowedAudiences,
    });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    // Una identidad SIN driverId (no es un conductor) no puede leer ofertas de dispatch → found=false
    // (fail-closed sin filtrar existencia). El driverId firmado lo puso el driver-bff vía GetDriverByUser.
    if (!identity.driverId) return EMPTY_MATCH;
    try {
      const m = await this.dispatch.getMatch(matchId, identity.driverId);
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
  async getNearbyDrivers({
    lat,
    lon,
    vehicleType,
  }: GetNearbyDriversRequest): Promise<NearbyDriversReply> {
    // El service valida coords (dentro de Lima) y coacciona vehicleType al enum (inválido → todos):
    // el borde gRPC NO pasa por el ValidationPipe HTTP, así que la validación vive en el dominio.
    // proto3: un string no-seteado llega como '' (no undefined). Normalizamos ''/ausente → undefined
    // ("tipo no especificado = todos"). `.length` evita el cambio a `??`, que NO cubriría el '' de proto3.
    const drivers = await this.nearby.nearby(
      { lat, lon },
      vehicleType?.length ? vehicleType : undefined,
    );
    return {
      drivers: drivers.map((d) => ({ lat: d.lat, lon: d.lon, vehicleType: d.vehicleType })),
    };
  }
}
