import type { GeoPoint, NearbyVehiclesView } from '@veo/api-client';

/**
 * Tipo de vehículo para FILTRAR los autitos de ambiente (opcional). Ausente = todos los tipos.
 * Espejo del enum del contrato (`@veo/api-client`), expuesto acá para no acoplar los consumidores
 * de presentación al SDK directamente.
 */
export type NearbyVehicleType = 'CAR' | 'MOTO';

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
  getNearbyVehicles(coords: GeoPoint, vehicleType?: NearbyVehicleType): Promise<NearbyVehiclesView>;
}
