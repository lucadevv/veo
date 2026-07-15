import { ExternalServiceError, distanceMeters, type LatLon } from '@veo/utils';
import type {
  AutocompleteOptions,
  GeocodeResult,
  MapsCache,
  MapsClient,
  RouteManeuver,
  RouteResult,
  RouteStep,
  RouteWithStepsResult,
} from './types.js';
import { polylineToGeoJson } from './polyline.js';
import { normalizeManeuver, buildInstruction, type OsrmStepManeuver } from './steps.js';

type FetchImpl = typeof fetch;

export interface OsrmMapsClientOptions {
  /** Base URL de OSRM/Valhalla self-hosted (ej. http://osrm:5000). */
  osrmBaseUrl: string;
  /** Base URL de Nominatim self-hosted (ej. http://nominatim:8080). */
  nominatimBaseUrl: string;
  cache?: MapsCache;
  cacheTtlSeconds?: number;
  /** Inyectable para tests (por defecto el fetch global de Node 22). */
  fetchImpl?: FetchImpl;
  /** Timeout por request en ms. */
  timeoutMs?: number;
}

interface OsrmRouteResponse {
  code: string;
  routes?: { distance: number; duration: number; geometry: string }[];
}

interface OsrmStep {
  distance: number;
  geometry: string;
  name?: string;
  maneuver?: OsrmStepManeuver;
}

interface OsrmStepsResponse {
  code: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: string;
    legs?: { steps?: OsrmStep[] }[];
  }[];
}

/** Respuesta del servicio OSRM `/table` (matriz de duraciones, segundos). `null` = par no resoluble. */
interface OsrmTableResponse {
  code: string;
  /** durations[i][j] = duración(s) del source i al destination j; puede ser null. */
  durations?: (number | null)[][];
}

interface NominatimEntry {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  /**
   * Desglose de dirección (solo con `addressdetails=1`). En Lima el DISTRITO llega como `suburb` o
   * `city_district` según el mapeo OSM de la zona; caemos por prioridad hasta `city`/`county` como red
   * de seguridad. Todos opcionales (proveedor puede no traerlos).
   */
  address?: {
    suburb?: string;
    city_district?: string;
    town?: string;
    city?: string;
    municipality?: string;
    county?: string;
  };
}

/**
 * Extrae el DISTRITO del desglose de dirección de Nominatim. En Lima el distrito suele venir como
 * `suburb` o `city_district`; probamos por prioridad y caemos a town/city/... como último recurso.
 * `undefined` si no hay ninguno (el consumidor degrada honesto). No inventa: solo elige el campo presente.
 */
function districtOf(address: NominatimEntry['address']): string | undefined {
  if (!address) return undefined;
  return (
    address.suburb ??
    address.city_district ??
    address.town ??
    address.municipality ??
    address.city ??
    address.county
  );
}

/**
 * Cliente de mapas sobre infraestructura OSM self-hosted (OSRM/Valhalla + Nominatim).
 * Todo el tráfico se queda en nuestra infra (soberanía §0.7). Cachea rutas y geocodes.
 */
export class OsrmMapsClient implements MapsClient {
  private readonly fetchImpl: FetchImpl;
  private readonly cacheTtl: number;

  constructor(private readonly opts: OsrmMapsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtl = opts.cacheTtlSeconds ?? 3600;
  }

  async route(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteResult> {
    // La clave de caché incluye las paradas intermedias (Ola 2B) para no colisionar con la directa.
    const wpKey = waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|');
    const cacheKey = `route:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}:${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}${wpKey ? `:wp:${wpKey}` : ''}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as RouteResult;

    // OSRM acepta una lista de coordenadas `lon,lat;...`: origen → paradas (en orden) → destino.
    const coords = [origin, ...waypoints, destination].map((p) => `${p.lon},${p.lat}`).join(';');
    const url =
      `${this.opts.osrmBaseUrl}/route/v1/driving/` +
      `${coords}` +
      `?overview=full&geometries=polyline`;
    const body = await this.getJson<OsrmRouteResponse>(url, 'OSRM route');
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best) {
      throw new ExternalServiceError('OSRM no devolvió ruta', { code: body.code });
    }
    const result: RouteResult = {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      polyline: best.geometry,
      // La geometría completa (overview=full) se deriva de la polyline → GeoJSON para MapLibre.
      geometry: polylineToGeoJson(best.geometry),
    };
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  async routeWithSteps(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteWithStepsResult> {
    const wpKey = waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|');
    const cacheKey = `route-steps:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}:${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}${wpKey ? `:wp:${wpKey}` : ''}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as RouteWithStepsResult;

    const coords = [origin, ...waypoints, destination].map((p) => `${p.lon},${p.lat}`).join(';');
    const url =
      `${this.opts.osrmBaseUrl}/route/v1/driving/` +
      `${coords}` +
      `?overview=full&geometries=polyline&steps=true`;
    const body = await this.getJson<OsrmStepsResponse>(url, 'OSRM route steps');
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best) {
      throw new ExternalServiceError('OSRM no devolvió ruta con pasos', { code: body.code });
    }
    // Aplana los steps de todas las piernas (legs) del trayecto (origen→paradas→destino).
    const steps: RouteStep[] = (best.legs ?? []).flatMap((leg) =>
      (leg.steps ?? []).map((step) => OsrmMapsClient.toRouteStep(step)),
    );
    const result: RouteWithStepsResult = {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      polyline: best.geometry,
      geometry: polylineToGeoJson(best.geometry),
      steps,
    };
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  private static toRouteStep(step: OsrmStep): RouteStep {
    const maneuver: RouteManeuver = normalizeManeuver(step.maneuver);
    return {
      instruction: buildInstruction(maneuver, step.name),
      distanceMeters: Math.round(step.distance),
      maneuver,
      geometryPolyline: step.geometry ?? '',
    };
  }

  async eta(origin: LatLon, destination: LatLon): Promise<number> {
    return (await this.route(origin, destination)).durationSeconds;
  }

  /** A1 — fallback de ETA (s) por gran-círculo (mismas constantes urbanas que el motor local: 24 km/h
   *  con factor de sinuosidad 1.3) cuando OSRM no resuelve un par (null en la matriz). */
  private static fallbackEta(origin: LatLon, destination: LatLon): number {
    const AVG_SPEED_MS = (24 * 1000) / 3600;
    const DETOUR_FACTOR = 1.3;
    const meters = distanceMeters(origin, destination) * DETOUR_FACTOR;
    return Math.round(meters / AVG_SPEED_MS);
  }

  /**
   * A1 — ETA en LOTE en UNA sola request al servicio `/table` de OSRM (sustituye el N×`route` secuencial
   * del broadcast). Layout de coordenadas: `[...origins, destination]`; pedimos `sources=0..N-1` y un
   * único `destinations=N`, así `durations[i][0]` es la duración del origen i al destino común. Un par
   * `null` (OSRM no encontró ruta) cae al fallback de gran-círculo. Si TODA la request falla (red/timeout/
   * código no-Ok), TODO el lote cae al fallback — espeja el "no rompas el broadcast" del `eta` single.
   * Devuelve un array alineado con `origins` (mismo orden y longitud).
   */
  async etaBatch(origins: readonly LatLon[], destination: LatLon): Promise<number[]> {
    if (origins.length === 0) return [];

    const points = [...origins, destination];
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
    const destIndex = origins.length; // el destino es el ÚLTIMO punto.
    const sources = origins.map((_, i) => i).join(';');
    const url =
      `${this.opts.osrmBaseUrl}/table/v1/driving/${coords}` +
      `?sources=${sources}&destinations=${destIndex}&annotations=duration`;

    try {
      const body = await this.getJson<OsrmTableResponse>(url, 'OSRM table');
      if (body.code !== 'Ok' || !body.durations) {
        throw new ExternalServiceError('OSRM /table no devolvió matriz', { code: body.code });
      }
      return origins.map((origin, i) => {
        const seconds = body.durations?.[i]?.[0];
        return typeof seconds === 'number'
          ? Math.round(seconds)
          : OsrmMapsClient.fallbackEta(origin, destination);
      });
    } catch {
      // La request entera falló (igual que el `eta` single, NO rompemos el broadcast): fallback total.
      return origins.map((origin) => OsrmMapsClient.fallbackEta(origin, destination));
    }
  }

  async geocode(query: string): Promise<GeocodeResult | null> {
    const cacheKey = `geocode:${query.toLowerCase()}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult;

    const url = `${this.opts.nominatimBaseUrl}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const entries = await this.getJson<NominatimEntry[]>(url, 'Nominatim search');
    const first = entries[0];
    if (!first) return null;
    const result = this.toGeocode(first);
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  async autocomplete(query: string, opts: AutocompleteOptions = {}): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    // El BFF ya corta en <3, pero protegemos también la capa de datos.
    if (trimmed.length < 3) return [];

    const limit = opts.limit ?? 6;
    const countryCodes = opts.countryCodes ?? 'pe';
    const cacheKey = `autocomplete:${countryCodes}:${limit}:${
      opts.near ? `${opts.near.lat.toFixed(3)},${opts.near.lon.toFixed(3)}:` : ''
    }${trimmed.toLowerCase()}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult[];

    const params = new URLSearchParams({
      q: trimmed,
      format: 'jsonv2',
      addressdetails: '1',
      limit: String(limit),
      countrycodes: countryCodes,
    });
    // Sesgo por proximidad: viewbox alrededor del punto (≈16 km) sin acotar duro (bounded=0).
    if (opts.near) {
      const delta = 0.15;
      const { lat, lon } = opts.near;
      params.set('viewbox', `${lon - delta},${lat + delta},${lon + delta},${lat - delta}`);
      params.set('bounded', '0');
    }

    const url = `${this.opts.nominatimBaseUrl}/search?${params.toString()}`;
    const entries = await this.getJson<NominatimEntry[]>(url, 'Nominatim autocomplete');
    const results = entries.map((entry) => this.toGeocode(entry));
    await this.opts.cache?.set(cacheKey, JSON.stringify(results), this.cacheTtl);
    return results;
  }

  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    const cacheKey = `reverse:${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult;

    const url = `${this.opts.nominatimBaseUrl}/reverse?format=jsonv2&addressdetails=1&lat=${point.lat}&lon=${point.lon}`;
    const entry = await this.getJson<NominatimEntry & { error?: string }>(url, 'Nominatim reverse');
    if (entry.error || !entry.lat) return null;
    const result = this.toGeocode(entry);
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  private toGeocode(entry: NominatimEntry): GeocodeResult {
    return {
      lat: Number(entry.lat),
      lon: Number(entry.lon),
      displayName: entry.display_name,
      name: entry.name,
      // Distrito del desglose de dirección (addressdetails); undefined si el proveedor no lo trae.
      district: districtOf(entry.address),
    };
  }

  private async getJson<T>(url: string, what: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 4000);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'veo-maps/0.1 (self-hosted)' },
      });
      if (!res.ok) {
        throw new ExternalServiceError(`${what} respondió ${res.status}`, { status: res.status });
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      throw new ExternalServiceError(`${what} falló`, { cause: String(err) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
