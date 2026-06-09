/**
 * Fachada de mapas del BFF: usa OSRM/Nominatim self-hosted (soberanía §0.7) con fallback
 * automático al motor local determinista si OSRM no responde. Se usa para ETA y routePolyline
 * de la vista de seguimiento familiar (conductor → destino).
 */
import { ExternalServiceError, type LatLon } from '@veo/utils';
import {
  LocalMapsEngine,
  MapboxMapsClient,
  OsrmMapsClient,
  type AutocompleteOptions,
  type GeocodeResult,
  type MapsClient,
  type RouteResult,
  type RouteWithStepsResult,
} from '@veo/maps';

/** Cliente de mapas con degradación: intenta el primario (OSRM) y cae al motor local ante fallo. */
export class FallbackMapsClient implements MapsClient {
  private readonly fallback: LocalMapsEngine;

  constructor(private readonly primary: MapsClient) {
    this.fallback = new LocalMapsEngine();
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteResult> {
    try {
      // BUG FIX: esta fachada declaraba `route(origin, destination)` SIN waypoints → el 3er argumento
      // (las paradas) que le pasa maps.service/trips.service se DESCARTABA → la ruta y la tarifa NO
      // cambiaban al agregar una parada en la app (OSRM caído → cae al fallback, que también las perdía).
      return await this.primary.route(origin, destination, waypoints);
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        return this.fallback.route(origin, destination, waypoints);
      }
      throw err;
    }
  }

  async routeWithSteps(
    origin: LatLon,
    destination: LatLon,
    waypoints?: readonly LatLon[],
  ): Promise<RouteWithStepsResult> {
    try {
      return await this.primary.routeWithSteps(origin, destination, waypoints);
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        return this.fallback.routeWithSteps(origin, destination, waypoints);
      }
      throw err;
    }
  }

  async eta(origin: LatLon, destination: LatLon): Promise<number> {
    try {
      return await this.primary.eta(origin, destination);
    } catch (err) {
      if (err instanceof ExternalServiceError) return this.fallback.eta(origin, destination);
      throw err;
    }
  }

  async etaBatch(origins: readonly LatLon[], destination: LatLon): Promise<number[]> {
    try {
      return await this.primary.etaBatch(origins, destination);
    } catch (err) {
      if (err instanceof ExternalServiceError) return this.fallback.etaBatch(origins, destination);
      throw err;
    }
  }

  async geocode(query: string): Promise<GeocodeResult | null> {
    try {
      return await this.primary.geocode(query);
    } catch (err) {
      // Degradación: el motor local resuelve sobre el dataset curado de Lima (soberano, sin red).
      if (err instanceof ExternalServiceError) return this.fallback.geocode(query);
      throw err;
    }
  }

  async autocomplete(query: string, opts?: AutocompleteOptions): Promise<GeocodeResult[]> {
    try {
      return await this.primary.autocomplete(query, opts);
    } catch (err) {
      // Degradación: sugerencias del dataset curado de Lima (sesgadas por proximidad si viene `near`).
      if (err instanceof ExternalServiceError) return this.fallback.autocomplete(query, opts);
      throw err;
    }
  }

  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    try {
      return await this.primary.reverse(point);
    } catch (err) {
      // Degradación: el lugar del dataset de Lima más cercano al punto.
      if (err instanceof ExternalServiceError) return this.fallback.reverse(point);
      throw err;
    }
  }
}

export interface BuildMapsClientInput {
  mode: 'osrm' | 'local' | 'mapbox';
  osrmUrl: string;
  nominatimUrl: string;
  /** Token público de Mapbox (`pk....`). Requerido solo en modo `mapbox`. */
  mapboxAccessToken?: string;
}

/**
 * Construye el cliente de mapas según el modo configurado:
 * - `local`: motor determinista puro (sin red).
 * - `osrm`:  OSRM/Nominatim self-hosted con fallback al motor local ante fallo.
 * - `mapbox`: APIs HTTP de Mapbox (token `pk`, server-side) con fallback al motor local ante fallo
 *   (degradación honesta si Mapbox falla o no hay red).
 */
export function buildMapsClient(input: BuildMapsClientInput): MapsClient {
  if (input.mode === 'local') return new LocalMapsEngine();
  if (input.mode === 'mapbox') {
    if (!input.mapboxAccessToken) {
      throw new Error('buildMapsClient: mode "mapbox" requiere mapboxAccessToken (pk)');
    }
    const mapbox = new MapboxMapsClient({ accessToken: input.mapboxAccessToken });
    return new FallbackMapsClient(mapbox);
  }
  const osrm = new OsrmMapsClient({
    osrmBaseUrl: input.osrmUrl,
    nominatimBaseUrl: input.nominatimUrl,
  });
  return new FallbackMapsClient(osrm);
}
