import type { MapPoint, PlaceSuggestionList } from '@veo/api-client';

/**
 * Contrato del repositorio de búsqueda de LUGARES del conductor (capa domain). Espeja el del pasajero:
 * cubre el autocompletado de direcciones. Implementación concreta en `data/` contra el driver-bff
 * (`/maps/*`); el cliente nunca habla con proveedores de mapas directos (la infra soberana
 * OSRM/Nominatim vive detrás del BFF).
 */
export interface MapsRepository {
  /** GET /maps/autocomplete?q&lat&lng → sugerencias (sesgadas por `near` si se provee). */
  autocomplete(query: string, near?: MapPoint): Promise<PlaceSuggestionList>;
}
