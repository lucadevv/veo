// Entidades de dominio de búsqueda de LUGARES del conductor (contrato soberano en @veo/api-client).
// Espeja el feature de mapas del pasajero: reusa los MISMOS tipos/schemas, no los redefine.
export type { MapPoint, PlaceSuggestion, PlaceSuggestionList } from '@veo/api-client';

/** Longitud mínima de la consulta para llamar al autocompletado (el bff responde [] si q<3). */
export const MIN_QUERY_LENGTH = 3;

/** Un lugar elegido por el conductor: punto geográfico + etiqueta legible. */
export interface RoutePlace {
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
}
