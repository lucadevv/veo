import type { MapPoint } from '@veo/api-client';

// Entidades de dominio de Mapas (contrato soberano en @veo/api-client).
export type {
  GeoJsonLineString,
  MapPoint,
  PlaceSuggestion,
  PlaceSuggestionList,
  QuoteOption,
  QuoteRequest,
  QuoteResult,
  ReversePlace,
} from '@veo/api-client';

/** Longitud mínima de la consulta para llamar al autocompletado (el bff responde [] si q<3). */
export const MIN_QUERY_LENGTH = 3;

/** Máximo de paradas intermedias permitidas por el contrato (Ola 2B · paradas múltiples). */
export const MAX_WAYPOINTS = 3;

/** Un lugar elegido por el usuario: punto geográfico + etiqueta legible. */
export interface RoutePlace {
  point: MapPoint;
  title: string;
  subtitle?: string;
}

/** Una parada ya tiene dirección cuando el buscador le fijó un título (no es un marcador vacío). */
export function isWaypointSet(place: RoutePlace): boolean {
  return place.title.trim().length > 0;
}
