import type { LatLon } from '@veo/utils';

export type { LatLon };

/**
 * Geometría GeoJSON de una ruta (LineString). Coordenadas en orden GeoJSON `[lon, lat]`.
 * Lista para pintarse como capa en MapLibre/Mapbox sin transformaciones.
 */
export interface GeoJsonLineString {
  type: 'LineString';
  coordinates: [number, number][];
}

/** Resultado de un cálculo de ruta (OSRM/Valhalla o motor local). */
export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** Polyline codificada (precision 5, formato Google/OSRM). Vacío si el proveedor no la entrega. */
  polyline: string;
  /** Geometría GeoJSON (LineString) de la ruta completa, derivada de OSRM (overview=full). */
  geometry: GeoJsonLineString;
}

/**
 * Tipo de maniobra normalizado para la navegación turn-by-turn (Ola 2C).
 * Subconjunto estable derivado del `maneuver.type`/`modifier` de OSRM. La app móvil lo mapea a un
 * icono/locución. `arrive` cierra la ruta; `depart` la abre.
 */
export type RouteManeuver =
  | 'depart'
  | 'turn-left'
  | 'turn-right'
  | 'turn-slight-left'
  | 'turn-slight-right'
  | 'turn-sharp-left'
  | 'turn-sharp-right'
  | 'uturn'
  | 'straight'
  | 'merge'
  | 'roundabout'
  | 'fork'
  | 'arrive';

/**
 * Un paso/maniobra de la navegación turn-by-turn (Ola 2C). Cada step tiene una instrucción legible
 * (es-PE), la distancia de ESE tramo, el tipo de maniobra normalizado y su geometría (polyline).
 */
export interface RouteStep {
  /** Instrucción legible (es-PE), p. ej. "Gira a la derecha en Av. Larco". */
  instruction: string;
  /** Distancia de este tramo en metros. */
  distanceMeters: number;
  /** Tipo de maniobra normalizado. */
  maneuver: RouteManeuver;
  /** Geometría del tramo como polyline codificada (precision 5). Vacía si el motor no la entrega. */
  geometryPolyline: string;
}

/**
 * Resultado de una ruta CON pasos de navegación (Ola 2C). Extiende `RouteResult` con `steps`.
 * Lo consume driver-bff (`GET /trips/:id/route`) para la navegación turn-by-turn del conductor.
 */
export interface RouteWithStepsResult extends RouteResult {
  steps: RouteStep[];
}

/** Resultado de geocoding/reverse-geocoding (Nominatim). */
export interface GeocodeResult {
  lat: number;
  lon: number;
  /** Dirección completa legible (Nominatim `display_name`). */
  displayName: string;
  /** Nombre corto del lugar (Nominatim `name`), si lo entrega el proveedor. */
  name?: string;
}

/** Opciones del autocompletado de direcciones. */
export interface AutocompleteOptions {
  /** Sesgo por proximidad: prioriza resultados cercanos a este punto (sin filtrar duro). */
  near?: LatLon;
  /** Máximo de sugerencias (default 6). */
  limit?: number;
  /** Códigos de país ISO-3166-1 alpha-2 separados por coma (default 'pe'). */
  countryCodes?: string;
}

/** Caché opcional inyectable (Redis en prod). */
export interface MapsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Contrato del cliente de mapas que consumen trip-service y dispatch-service. */
export interface MapsClient {
  /**
   * Ruta conducible origen→destino (distancia, duración, polyline).
   * `waypoints` (Ola 2B · paradas múltiples): puntos intermedios ORDENADOS entre origen y destino;
   * la ruta resultante pasa por todos en orden y su distancia/duración los incluye. Omitir = directo.
   */
  route(origin: LatLon, destination: LatLon, waypoints?: readonly LatLon[]): Promise<RouteResult>;
  /**
   * Ruta con PASOS de navegación turn-by-turn (Ola 2C · soberana, OSRM `steps=true`). Devuelve lo
   * mismo que `route` MÁS `steps` (instrucción, distancia, maniobra, geometría por tramo). No rompe
   * `route`: es un método aparte. `waypoints` se respetan en orden (origen→paradas→destino).
   */
  routeWithSteps(
    origin: LatLon,
    destination: LatLon,
    waypoints?: readonly LatLon[],
  ): Promise<RouteWithStepsResult>;
  /** Atajo: solo la duración estimada en segundos. */
  eta(origin: LatLon, destination: LatLon): Promise<number>;
  /**
   * ETA en LOTE: la duración estimada (s) de CADA origen hacia UN destino común, en UNA sola pasada.
   * Devuelve un array alineado con `origins` (mismo orden, misma longitud). Sustituye el N×`eta`
   * secuencial del hot-path de broadcast (A1): un origen no resoluble cae a un fallback razonable (no
   * rompe el lote). OSRM lo resuelve con un único `/table` (matriz de duraciones); el motor local
   * mapea cada uno in-proc (barato).
   */
  etaBatch(origins: readonly LatLon[], destination: LatLon): Promise<number[]>;
  /** Geocoding directo (texto → coordenadas). `null` si no hay resultados. */
  geocode(query: string): Promise<GeocodeResult | null>;
  /** Autocompletado: múltiples sugerencias para un texto parcial. `[]` si no hay resultados. */
  autocomplete(query: string, opts?: AutocompleteOptions): Promise<GeocodeResult[]>;
  /** Reverse geocoding (coordenadas → dirección). `null` si no hay resultados. */
  reverse(point: LatLon): Promise<GeocodeResult | null>;
}
