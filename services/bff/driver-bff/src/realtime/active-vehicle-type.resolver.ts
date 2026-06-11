/**
 * Resuelve el TIPO de vehículo ACTIVO del conductor desde fleet (server-authoritative), para sellarlo
 * en el ping de GPS. ANTES el tipo lo declaraba el cliente en cada `location` y viajaba sin validar al
 * dispatch (spoofeable: un conductor de auto podía pedir viajes de MOTO). Ahora el BFF lo sobreescribe
 * con el tipo del vehículo que el conductor tiene SELECCIONADO + con docs vigentes en fleet.
 *
 * El ping es por-segundo: resolver fleet en cada uno sería caro, así que cacheamos por conductor con un
 * TTL corto. Un cambio de vehículo se refleja en ≤ TTL (no instantáneo, pero el hot-index de dispatch ya
 * vive ~60s, así que la granularidad alcanza). Si fleet no responde, degradación honesta: usamos el
 * `fallback` (lo que vino en el ping) — no rompemos el envío de ubicación por una caída de fleet.
 */
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@veo/auth';
import type { VehicleClass } from '@veo/shared-types';
import { RestGateway } from '../infra/rest.gateway';

/** Subconjunto del `driverVehicleView` de fleet que necesitamos (solo la clase). */
interface ActiveVehicleReply {
  vehicleType: VehicleClass;
}

@Injectable()
export class ActiveVehicleTypeResolver {
  private readonly cache = new Map<string, { type: VehicleClass; expiresAt: number }>();
  private static readonly TTL_MS = 20_000;

  constructor(private readonly rest: RestGateway) {}

  /**
   * Tipo del vehículo activo del conductor. `fallback` se usa si fleet no responde o el conductor no
   * tiene ningún vehículo operable (204) — en ese caso conservamos lo que vino en el ping (no peor que
   * el comportamiento previo). La clave de cache es el `userId` (lo que fleet usa como `driver_id`).
   */
  async resolve(identity: AuthenticatedUser, fallback: VehicleClass): Promise<VehicleClass> {
    const key = identity.userId;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.type;
    try {
      const active = await this.rest
        .client('fleet')
        .get<ActiveVehicleReply | undefined>('/drivers/vehicles/active', { identity });
      const type = active?.vehicleType ?? fallback;
      this.cache.set(key, { type, expiresAt: now + ActiveVehicleTypeResolver.TTL_MS });
      return type;
    } catch {
      return fallback;
    }
  }
}
