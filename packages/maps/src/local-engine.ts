import { distanceMeters, type LatLon } from '@veo/utils';
import type {
  AutocompleteOptions,
  GeocodeResult,
  MapsClient,
  RouteManeuver,
  RouteResult,
  RouteStep,
  RouteWithStepsResult,
} from './types.js';
import { encodePolyline } from './polyline.js';
import { buildInstruction } from './steps.js';
import { LimaGeocoder } from './local-geocoder.js';

export interface LocalMapsEngineOptions {
  /** Velocidad urbana media en km/h para estimar duración (Lima ≈ 24 km/h). */
  avgSpeedKmh?: number;
  /** Factor de sinuosidad: la ruta real es más larga que la línea recta (≈ 1.3 en ciudad). */
  detourFactor?: number;
}

/**
 * Motor de routing propio (sin dependencias externas). Calcula distancia por gran círculo
 * ajustada por un factor de sinuosidad y deriva la duración con una velocidad urbana media.
 *
 * No es un mock: es un estimador determinista real, usado cuando OSRM aún no tiene cargado
 * el extracto OSM de Perú. En producción se usa `OsrmMapsClient`. No hace geocoding.
 */
export class LocalMapsEngine implements MapsClient {
  private readonly avgSpeedMs: number;
  private readonly detourFactor: number;
  /** Geocoder soberano sobre el dataset curado de Lima (sin red). */
  private readonly geocoder = new LimaGeocoder();

  constructor(opts: LocalMapsEngineOptions = {}) {
    const avgSpeedKmh = opts.avgSpeedKmh ?? 24;
    this.avgSpeedMs = (avgSpeedKmh * 1000) / 3600;
    this.detourFactor = opts.detourFactor ?? 1.3;
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteResult> {
    // Ola 2B: la ruta atraviesa origen → paradas (en orden) → destino. Sumamos los tramos.
    const points = [origin, ...waypoints, destination];
    let straight = 0;
    let prev = points[0] ?? origin;
    for (const point of points.slice(1)) {
      straight += distanceMeters(prev, point);
      prev = point;
    }
    const distance = Math.round(straight * this.detourFactor);
    const duration = Math.round(distance / this.avgSpeedMs);
    return {
      distanceMeters: distance,
      durationSeconds: duration,
      polyline: '',
      // Sin OSRM no hay calles: aproximamos con segmentos rectos entre cada punto (orden GeoJSON).
      geometry: {
        type: 'LineString',
        coordinates: points.map((p) => [p.lon, p.lat] as [number, number]),
      },
    };
  }

  /**
   * Ola 2C: ruta con pasos plausibles SIN OSRM. No es un mock: deriva una maniobra real del cambio
   * de rumbo entre tramos consecutivos (origen→paradas→destino) y reparte la distancia por tramo,
   * con geometría (polyline) de cada segmento. Útil para dev/CI cuando OSRM aún no tiene Perú.
   */
  async routeWithSteps(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteWithStepsResult> {
    const base = await this.route(origin, destination, waypoints);
    const points: LatLon[] = [origin, ...waypoints, destination];
    const steps: RouteStep[] = [];
    let prevBearing: number | null = null;
    let prev = origin;

    points.slice(1).forEach((to, idx) => {
      const from = prev;
      const segMeters = Math.round(distanceMeters(from, to) * this.detourFactor);
      const bearing = LocalMapsEngine.bearing(from, to);
      const maneuver: RouteManeuver =
        idx === 0 ? 'depart' : LocalMapsEngine.turnFromBearings(prevBearing, bearing);
      steps.push({
        instruction: buildInstruction(maneuver),
        distanceMeters: segMeters,
        maneuver,
        geometryPolyline: encodePolyline([
          [from.lon, from.lat],
          [to.lon, to.lat],
        ]),
      });
      prevBearing = bearing;
      prev = to;
    });
    // Step final de llegada (distancia 0), como hace OSRM.
    steps.push({
      instruction: buildInstruction('arrive'),
      distanceMeters: 0,
      maneuver: 'arrive',
      geometryPolyline: '',
    });

    return { ...base, steps };
  }

  /** Rumbo inicial (grados 0..360, 0 = norte) del segmento `a→b`. */
  private static bearing(a: LatLon, b: LatLon): number {
    const toRad = (d: number): number => (d * Math.PI) / 180;
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** Deriva una maniobra del giro (delta de rumbo) entre dos tramos consecutivos. */
  private static turnFromBearings(prev: number | null, next: number): RouteManeuver {
    if (prev === null) return 'straight';
    const delta = ((next - prev + 540) % 360) - 180; // (-180, 180], + = derecha
    const abs = Math.abs(delta);
    if (abs < 20) return 'straight';
    if (abs > 150) return 'uturn';
    const sharp = abs > 110;
    const slight = abs < 45;
    if (delta > 0) return sharp ? 'turn-sharp-right' : slight ? 'turn-slight-right' : 'turn-right';
    return sharp ? 'turn-sharp-left' : slight ? 'turn-slight-left' : 'turn-left';
  }

  async eta(origin: LatLon, destination: LatLon): Promise<number> {
    return (await this.route(origin, destination)).durationSeconds;
  }

  /**
   * A1 — ETA en lote. El motor es in-proc (sin red): mapear cada origen con `eta` es barato, así que
   * NO hay matriz que pedir; simplemente computamos cada duración localmente. Orden/longitud alineados
   * con `origins`.
   */
  async etaBatch(origins: readonly LatLon[], destination: LatLon): Promise<number[]> {
    return Promise.all(origins.map((origin) => this.eta(origin, destination)));
  }

  /**
   * Geocoding directo sobre el dataset curado de Lima (soberano, sin red). Devuelve el mejor match
   * textual; `null` si nada coincide. Es real para dev/CI cuando Nominatim aún no tiene Perú cargado.
   */
  async geocode(query: string): Promise<GeocodeResult | null> {
    return this.geocoder.geocode(query);
  }

  /**
   * Autocompletado sobre el dataset de Lima: match por prefijo/substring (sin tildes) sobre
   * nombre+distrito+aliases, ORDENADO por proximidad a `opts.near` si viene. Top `opts.limit` (def. 8).
   * `[]` si el texto es muy corto (<3, espeja el corte del BFF/OSRM) o nada coincide.
   */
  async autocomplete(query: string, opts: AutocompleteOptions = {}): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];
    return this.geocoder.autocomplete(trimmed, opts.near, opts.limit ?? 8);
  }

  /**
   * Reverse geocoding: el lugar del dataset MÁS CERCANO a `point` (gran círculo), con su label real.
   * Permite que la pastilla "Tu ubicación" muestre una dirección creíble en dev en vez del fallback.
   */
  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    return this.geocoder.reverse(point);
  }
}
