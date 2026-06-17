/**
 * Fachada de mapas del driver-bff (Ola 2C · navegación turn-by-turn). Usa OSRM/Nominatim
 * self-hosted (soberanía §0.7) con degradación automática al motor local determinista si OSRM no
 * responde, de modo que `GET /trips/:id/route` siempre devuelve pasos plausibles en dev/CI.
 */
import { ExternalServiceError, type LatLon } from '@veo/utils';
import {
  LocalMapsEngine,
  MapboxMapsClient,
  OsrmMapsClient,
  type AutocompleteOptions,
  type GeocodeResult,
  type MapsClient,
  type MapsMode,
  type RouteResult,
  type RouteWithStepsResult,
} from '@veo/maps';

/** Token de inyección de la fachada de mapas. */
export const MAPS = Symbol('MAPS');

/** Cliente de mapas con degradación: intenta OSRM y cae al motor local ante fallo externo. */
export class FallbackMapsClient implements MapsClient {
  private readonly fallback: LocalMapsEngine;

  constructor(private readonly primary: MapsClient) {
    this.fallback = new LocalMapsEngine();
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    waypoints?: readonly LatLon[],
  ): Promise<RouteResult> {
    try {
      return await this.primary.route(origin, destination, waypoints);
    } catch (err) {
      if (err instanceof ExternalServiceError)
        return this.fallback.route(origin, destination, waypoints);
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
      if (err instanceof ExternalServiceError) return this.fallback.geocode(query);
      throw err;
    }
  }

  async autocomplete(query: string, opts?: AutocompleteOptions): Promise<GeocodeResult[]> {
    try {
      return await this.primary.autocomplete(query, opts);
    } catch (err) {
      if (err instanceof ExternalServiceError) return this.fallback.autocomplete(query, opts);
      throw err;
    }
  }

  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    try {
      return await this.primary.reverse(point);
    } catch (err) {
      if (err instanceof ExternalServiceError) return this.fallback.reverse(point);
      throw err;
    }
  }
}

export interface BuildMapsClientInput {
  mode: MapsMode;
  osrmUrl: string;
  nominatimUrl: string;
  /** Token público de Mapbox (`pk....`). Requerido solo en modo `mapbox`. */
  mapboxAccessToken?: string;
}

/**
 * Construye el cliente de mapas según el modo: `local` puro, `osrm` o `mapbox` (Directions API,
 * token pk server-side) — estos dos con fallback al motor local ante fallo externo (degradación honesta).
 */
export function buildMapsClient(input: BuildMapsClientInput): MapsClient {
  if (input.mode === 'local') return new LocalMapsEngine();
  if (input.mode === 'mapbox') {
    if (!input.mapboxAccessToken) {
      throw new Error('buildMapsClient: mode "mapbox" requiere mapboxAccessToken (pk)');
    }
    return new FallbackMapsClient(new MapboxMapsClient({ accessToken: input.mapboxAccessToken }));
  }
  const osrm = new OsrmMapsClient({
    osrmBaseUrl: input.osrmUrl,
    nominatimBaseUrl: input.nominatimUrl,
  });
  return new FallbackMapsClient(osrm);
}
