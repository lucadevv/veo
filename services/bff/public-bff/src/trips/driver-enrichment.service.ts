import { Inject, Injectable } from '@nestjs/common';
import { GrpcServiceClient } from '@veo/rpc';
import { GRPC_FLEET, GRPC_IDENTITY, GRPC_RATING } from '../infra/downstream.tokens';
import type { AggregateReply, DriverReply, DriverVehiclesReply } from '../infra/grpc-types';

/** Datos del conductor que enriquecen una oferta de la puja (BE-1) para que el pasajero elija. */
export interface OfferDriverInfo {
  /** BE-1b · nombre visible del conductor. Null = sin nombre / downstream no disponible. */
  driverName: string | null;
  /** Rating (avg 30d si hay viajes calificados, si no el promedio histórico). Null = sin rating. */
  rating: number | null;
  ratingCount: number;
  /** Vehículo ACTIVO del conductor (sin match aún → se resuelve por driverId). Null = sin vehículo. */
  vehicle: { make: string; model: string; color: string; plate: string } | null;
}

const EMPTY: OfferDriverInfo = { driverName: null, rating: null, ratingCount: 0, vehicle: null };

/**
 * BE-1 · enriquece una oferta de la puja con rating + vehículo del conductor, llamando gRPC a
 * rating/identity/fleet (Path B: el BFF es la capa de agregación; dispatch queda fino, §4-bis). Como
 * `OfferView` solo trae `driverId` (sin match ⇒ sin vehicleId), el vehículo se resuelve con
 * `fleet.GetDriverVehicles(driverId)`. Cache in-proc por driverId (espejo del cache de elegibilidad H10):
 * el board se refresca cada 5s y varios pasajeros ven al mismo conductor → evita N×3 gRPC por refetch.
 * Degradación honesta: si un downstream falla, ese campo queda null (no rompe la lista de ofertas).
 */
@Injectable()
export class DriverEnrichmentService {
  /** Cache por driverId. TTL corto: el rating/vehículo cambian en el orden de minutos/horas, no segundos. */
  private static readonly TTL_MS = 15_000;
  /** Tope anti-leak (espejo H11): por encima, no se cachea (se sirve fresco). */
  private static readonly MAX_ENTRIES = 5_000;
  /**
   * SF · single-flight: se cachea la PROMISE (no el valor resuelto), desde ANTES del primer await. Los N
   * misses concurrentes del mismo driver (N pasajeros mirando boards con el mismo conductor) comparten el
   * MISMO vuelo de 3 gRPC en vez de disparar N×3 (stampede). El fetch nunca rechaza (cada downstream cae
   * a null), así que una Promise cacheada jamás queda "envenenada" con rechazo.
   */
  private readonly cache = new Map<string, { value: Promise<OfferDriverInfo>; expiresAt: number }>();

  constructor(
    @Inject(GRPC_IDENTITY) private readonly identityGrpc: GrpcServiceClient,
    @Inject(GRPC_RATING) private readonly ratingGrpc: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleetGrpc: GrpcServiceClient,
  ) {}

  enrich(driverId: string, meta: Record<string, string>): Promise<OfferDriverInfo> {
    const now = Date.now();
    const hit = this.cache.get(driverId);
    if (hit && hit.expiresAt > now) return hit.value;

    const inFlight = this.fetchInfo(driverId, meta);
    if (this.cache.size < DriverEnrichmentService.MAX_ENTRIES) {
      this.cache.set(driverId, { value: inFlight, expiresAt: now + DriverEnrichmentService.TTL_MS });
    }
    return inFlight;
  }

  private async fetchInfo(driverId: string, meta: Record<string, string>): Promise<OfferDriverInfo> {
    // Tolerante a fallos: cada downstream que falle deja su campo en null (la lista de ofertas no rompe).
    // El conductor se resuelve PRIMERO: fleet indexa los vehículos por `User.id` (NO por `Driver.id`, que
    // es lo que trae la oferta), así que el vehículo se busca con el `userId` resuelto vía identity. Sin
    // este mapeo, GetDriverVehicles devolvía vacío SIEMPRE (el auto nunca salía en la puja — bug latente).
    const driver = await this.identityGrpc
      .call<DriverReply>('GetDriver', { id: driverId }, meta)
      .catch(() => null);
    const [aggregate, vehicles] = await Promise.all([
      this.ratingGrpc.call<AggregateReply>('GetAggregate', { subjectId: driverId }, meta).catch(() => null),
      driver?.found && driver.userId
        ? this.fleetGrpc
            .call<DriverVehiclesReply>('GetDriverVehicles', { id: driver.userId }, meta)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    // Rating: el rolling 30d si hay viajes calificados; si no, el promedio histórico del driver.
    const rating =
      aggregate && aggregate.count30d > 0
        ? aggregate.rollingAvg30d
        : driver && driver.averageRating > 0
          ? driver.averageRating
          : null;

    const active = vehicles?.vehicles?.find((v) => v.active) ?? vehicles?.vehicles?.[0] ?? null;
    return {
      // BE-1b — "" del proto (no registrado / found=false) se normaliza a null para degradar honesto.
      driverName: driver?.name?.length ? driver.name : null,
      rating,
      ratingCount: aggregate?.count30d ?? 0,
      vehicle: active
        ? { make: active.make, model: active.model, color: active.color, plate: active.plate }
        : null,
    };
  }
}

export { EMPTY as EMPTY_OFFER_DRIVER_INFO };
