/**
 * Cliente de mapas con degradación honesta (espejo del FallbackMapsClient del public-bff): intenta
 * el proveedor primario (OSRM/Mapbox) y ante `ExternalServiceError` cae al motor local determinista.
 *
 * Constraint (ruta canónica del viaje): trip-service PERSISTE la ruta que este puerto devuelve al
 * crear / cambiar destino / aceptar parada. El proveedor externo caído NO puede romper esas
 * operaciones (antes de este wrapper, un Mapbox caído tiraba el create con 5xx): el motor local
 * estima distancia/duración (la tarifa BR-T05 sigue calculable) y devuelve `polyline: ''` →
 * `route.polyline || null` persiste routePolyline NULL — la ruta canónica queda vacía, JAMÁS
 * inventada (los consumidores tienen fallback propio para polyline ausente).
 * Solo se degrada el fallo del PROVEEDOR (`ExternalServiceError`); cualquier otro error es un bug
 * y se propaga.
 */
import { ExternalServiceError, type LatLon } from '@veo/utils';
import {
  LocalMapsEngine,
  type AutocompleteOptions,
  type GeocodeResult,
  type MapsClient,
  type RouteResult,
  type RouteWithStepsResult,
} from '@veo/maps';

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
      return await this.primary.route(origin, destination, waypoints);
    } catch (err) {
      // Las paradas se preservan en el fallback: la distancia estimada (y la tarifa) las incluye.
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
