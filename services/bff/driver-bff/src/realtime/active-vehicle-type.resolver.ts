/**
 * Resuelve el vehículo ACTIVO del conductor desde fleet (server-authoritative) para sellarlo en el ping de
 * GPS: su TIPO (clase del pool de matching) y —B5-3— sus atributos de ELIGIBILIDAD (asientos/segmento/año
 * del modelo elegido). ANTES el tipo lo declaraba el cliente en cada `location` sin validar (spoofeable: un
 * conductor de auto podía pedir viajes de MOTO); ahora el BFF lo sobreescribe con lo que el conductor tiene
 * SELECCIONADO + con docs vigentes en fleet, y suma los attrs para que dispatch filtre por oferta
 * (confort=segment≥MID, xl=6 asientos) SIN consultar fleet en el hot-path.
 *
 * El ping es por-segundo: resolver fleet en cada uno sería caro, así que cacheamos por conductor con TTL
 * corto. Un cambio de vehículo se refleja en ≤ TTL. Si fleet no responde o no hay vehículo operable (204),
 * degradación honesta: devolvemos solo el tipo `fallback` (lo que vino en el ping) SIN attrs — dispatch no
 * restringe a ese conductor (no peor que antes); no rompemos el envío de ubicación por una caída de fleet.
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { FleetDocumentType, VehicleClass, VehicleSegment } from '@veo/shared-types';
import { RestGateway } from '../infra/rest.gateway';

/** Subconjunto del response de fleet (`/drivers/vehicles/active`) que necesitamos para el ping. */
interface ActiveVehicleReply {
  vehicleType: VehicleClass;
  year?: number;
  seats?: number;
  segment?: VehicleSegment;
  certifications?: FleetDocumentType[];
}

/** Vehículo activo resuelto: tipo (siempre) + attrs de eligibilidad (si el modelo del catálogo los aporta). */
export interface ResolvedActiveVehicle {
  vehicleType: VehicleClass;
  seats?: number;
  segment?: VehicleSegment;
  vehicleYear?: number;
  /** B5-3.2 · certs vigentes del conductor para el gate de verticales en dispatch (fail-closed). */
  certifications?: FleetDocumentType[];
}

@Injectable()
export class ActiveVehicleTypeResolver {
  private readonly cache = new Map<string, { value: ResolvedActiveVehicle; expiresAt: number }>();
  private static readonly TTL_MS = 20_000;

  constructor(private readonly rest: RestGateway) {}

  /**
   * Vehículo activo del conductor para el ping. `fallback` (tipo) se usa si fleet no responde o no hay
   * vehículo operable (204): en ese caso devolvemos solo el tipo, SIN attrs (degradación honesta). La
   * clave de cache es el `userId` (lo que fleet usa como `driver_id`).
   */
  async resolve(identity: AuthenticatedUser, fallback: VehicleClass): Promise<ResolvedActiveVehicle> {
    const key = identity.userId;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    try {
      const active = await this.rest
        .client('fleet')
        .get<ActiveVehicleReply | undefined>('/drivers/vehicles/active', { identity });
      const value: ResolvedActiveVehicle = active
        ? {
            vehicleType: active.vehicleType,
            seats: active.seats,
            segment: active.segment,
            vehicleYear: active.year,
            certifications: active.certifications,
          }
        : { vehicleType: fallback };
      this.cache.set(key, { value, expiresAt: now + ActiveVehicleTypeResolver.TTL_MS });
      return value;
    } catch {
      return { vehicleType: fallback };
    }
  }
}
