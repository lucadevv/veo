import type { MapPoint, PlaceSuggestionList, ReversePlace } from '@veo/api-client';

/**
 * Contrato del repositorio de búsqueda de LUGARES del conductor (capa domain). Espeja el del pasajero:
 * cubre el autocompletado de direcciones. Implementación concreta en `data/` contra el driver-bff
 * (`/maps/*`); el cliente nunca habla con proveedores de mapas directos (la infra soberana
 * OSRM/Nominatim vive detrás del BFF).
 */
export interface MapsRepository {
  /** GET /maps/autocomplete?q&lat&lng → sugerencias (sesgadas por `near` si se provee). */
  autocomplete(query: string, near?: MapPoint): Promise<PlaceSuggestionList>;
  /** GET /maps/reverse?lat&lng → etiqueta legible del punto (title = distrito, subtitle). Para las cards
   *  de puja (origen/destino ofuscados a ~111m → label a nivel distrito, sin revelar la puerta exacta). */
  reverse(point: MapPoint): Promise<ReversePlace>;
}
