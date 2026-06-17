import type {GeoPoint, NearbyVehicle} from '@veo/api-client';
import type {DispatchRepository, NearbyVehicleType} from './dispatchRepository';

/**
 * Vehículos cercanos ANÓNIMOS para pintar como AMBIENTE del mapa del pasajero (idle/searching).
 *
 * Decisión de dominio: el AMBIENTE NUNCA falla en pantalla. Un 4xx/red/parse del bff degrada a lista
 * VACÍA (no propaga el error): estos autitos son decoración de "hay autos por tu zona", jamás un banner
 * de error. La capa de presentación nunca tiene que manejar un estado de fallo por esto.
 */
export class GetNearbyVehiclesUseCase {
  constructor(private readonly repository: DispatchRepository) {}

  async execute(
    coords: GeoPoint,
    vehicleType?: NearbyVehicleType,
  ): Promise<NearbyVehicle[]> {
    try {
      const view = await this.repository.getNearbyVehicles(coords, vehicleType);
      return view.vehicles;
    } catch {
      // Ambiente: el fallo se traga, NO se muestra. Lista vacía = mapa limpio sin autitos.
      return [];
    }
  }
}
