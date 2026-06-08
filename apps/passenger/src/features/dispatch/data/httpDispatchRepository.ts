import {
  type GeoPoint,
  type HttpClient,
  type NearbyVehiclesView,
  nearbyVehiclesView,
} from '@veo/api-client';
import type { DispatchRepository, NearbyVehicleType } from '../domain/dispatchRepository';

/** Implementación de `DispatchRepository` contra el public-bff (`/dispatch/*`). */
export class HttpDispatchRepository implements DispatchRepository {
  constructor(private readonly http: HttpClient) {}

  getNearbyVehicles(
    coords: GeoPoint,
    vehicleType?: NearbyVehicleType,
  ): Promise<NearbyVehiclesView> {
    return this.http.get('/dispatch/nearby', {
      query: {
        lat: coords.lat,
        lon: coords.lon,
        // `vehicleType` opcional: solo se envía si se pidió filtrar (ausente = todos los tipos).
        ...(vehicleType ? { vehicleType } : {}),
      },
      schema: nearbyVehiclesView,
    });
  }
}
