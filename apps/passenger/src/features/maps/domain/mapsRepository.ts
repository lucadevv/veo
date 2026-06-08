import type {
  MapPoint,
  PlaceSuggestionList,
  QuoteRequest,
  QuoteResult,
  ReversePlace,
} from '@veo/api-client';

/**
 * Abstracción del repositorio de Mapas (DIP). Cubre el autocompletado de direcciones,
 * el geocoding inverso (etiqueta de un punto) y la cotización de previsualización con ruta.
 * Todo contra el public-bff (`/maps/*`); el cliente nunca habla con proveedores de mapas directos.
 */
export interface MapsRepository {
  /** GET /maps/autocomplete?q&lat&lng → sugerencias (sesgadas por `near` si se provee). */
  autocomplete(query: string, near?: MapPoint): Promise<PlaceSuggestionList>;
  /** GET /maps/reverse?lat&lng → etiqueta legible del punto. */
  reverse(point: MapPoint): Promise<ReversePlace>;
  /** POST /maps/quote → ruta real + opciones de tarifa por categoría (previsualización). */
  quote(request: QuoteRequest): Promise<QuoteResult>;
}
