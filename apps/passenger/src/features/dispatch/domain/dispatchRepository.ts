import type {GeoPoint, NearbyVehiclesView} from '@veo/api-client';
import type {VehicleClass} from '@veo/shared-types';

/**
 * Tipo de vehículo para FILTRAR los autitos de ambiente (opcional). Ausente = todos los tipos.
 * Alias de la `VehicleClass` canónica de `@veo/shared-types` (ADR 013: la definición local
 * duplicada del eje 1 se eliminó), expuesto acá para no acoplar los consumidores de presentación
 * al SDK directamente.
 */
export type NearbyVehicleType = VehicleClass;

/**
 * Abstracción del repositorio de Dispatch (DIP). Por ahora solo cubre los vehículos cercanos ANÓNIMOS
 * que se pintan como AMBIENTE del mapa del pasajero mientras está en el home (idle) o buscando
 * conductores (searching). No hay identidad de conductor acá: son puntos de "hay autos por tu zona".
 */
export interface DispatchRepository {
  /**
   * GET /dispatch/nearby?lat&lon[&vehicleType] → conductores disponibles cerca, ANÓNIMOS (sin driverId),
   * con coords redondeadas (~110m) por el backend. `vehicleType` opcional filtra por tipo; ausente = todos.
   * Devuelve `{ vehicles: [] }` si no hay nadie cerca o el origen cae fuera de Lima.
   */
  getNearbyVehicles(
    coords: GeoPoint,
    vehicleType?: NearbyVehicleType,
  ): Promise<NearbyVehiclesView>;
}
