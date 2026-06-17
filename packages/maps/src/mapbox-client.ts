/**
 * Cliente de mapas sobre las APIs HTTP de Mapbox (server-side, token público `pk`).
 *
 * NO usa el SDK de Mapbox (que requeriría `sk`/descarga): son llamadas HTTP planas a:
 *  - Geocoding API v6  (`/search/geocode/v6/forward` y `/reverse`)  → geocode/autocomplete/reverse
 *  - Directions API v5 (`/directions/v5/mapbox/driving-traffic/...`) → route/routeWithSteps/eta
 *  - Matrix API v1     (`/directions-matrix/v1/mapbox/...`)          → etaBatch (N orígenes → 1 destino)
 *
 * Mapea la respuesta de Mapbox a los tipos del puerto `MapsClient` EXACTAMENTE como lo hace
 * `OsrmMapsClient` (mismo shape de salida), de modo que es intercambiable detrás del puerto.
 * Determinista, sin `any`, normaliza tildes en el query y sesga por proximidad cuando hay `near`.
 */
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
import { buildInstruction, OsrmManeuverModifier, OsrmManeuverType, type OsrmStepManeuver } from './steps.js';

type FetchImpl = typeof fetch;

export interface MapboxMapsClientOptions {
  /** Token público de Mapbox (`pk....`). Server-side: solo llamadas HTTP, sin SDK. */
  accessToken: string;
  /** Base URL de la API de Mapbox. Default oficial; inyectable para tests. */
  baseUrl?: string;
  /** Perfil de ruteo de Directions/Matrix. Default `driving-traffic` (con tráfico). */
  profile?: string;
  /** País por defecto para geocoding (ISO-3166-1 alpha-2). Default `pe`. */
  defaultCountry?: string;
  cache?: MapsCache;
  cacheTtlSeconds?: number;
  /** Inyectable para tests (por defecto el fetch global de Node). */
  fetchImpl?: FetchImpl;
  /** Timeout por request en ms. */
  timeoutMs?: number;
}

// ── Shapes de las respuestas de Mapbox (solo los campos que consumimos) ──

interface MapboxDirectionsResponse {
  code: string;
  routes?: MapboxRoute[];
}

interface MapboxRoute {
  distance: number;
  duration: number;
  geometry: string;
  legs?: { steps?: MapboxStep[] }[];
}

interface MapboxStep {
  distance: number;
  geometry: string;
  name?: string;
  maneuver?: OsrmStepManeuver;
}

/** Respuesta de la Matrix API: `durations[i][j]` = segundos del source i al destination j (o null). */
interface MapboxMatrixResponse {
  code: string;
  durations?: (number | null)[][];
}

/** GeoJSON FeatureCollection de la Geocoding API v6. */
interface MapboxGeocodeResponse {
  type: string;
  features?: MapboxFeature[];
}

interface MapboxFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    name_preferred?: string;
    full_address?: string;
    place_formatted?: string;
    coordinates?: { longitude?: number; latitude?: number };
  };
}

export class MapboxMapsClient implements MapsClient {
  private readonly fetchImpl: FetchImpl;
  private readonly cacheTtl: number;
  private readonly baseUrl: string;
  private readonly profile: string;
  private readonly defaultCountry: string;

  constructor(private readonly opts: MapboxMapsClientOptions) {
    if (!opts.accessToken) {
      throw new Error('MapboxMapsClient: accessToken (pk) es obligatorio');
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtl = opts.cacheTtlSeconds ?? 3600;
    this.baseUrl = (opts.baseUrl ?? 'https://api.mapbox.com').replace(/\/+$/, '');
    this.profile = opts.profile ?? 'driving-traffic';
    this.defaultCountry = opts.defaultCountry ?? 'pe';
  }

  // ── Routing (Directions API v5) ──

  async route(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[] = [],
  ): Promise<RouteResult> {
    const wpKey = waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|');
    const cacheKey = `mbx:route:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}:${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}${wpKey ? `:wp:${wpKey}` : ''}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as RouteResult;

    const best = await this.fetchRoute(origin, destination, waypoints, false);
    const result: RouteResult = {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      polyline: best.geometry,
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
    const cacheKey = `mbx:route-steps:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}:${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}${wpKey ? `:wp:${wpKey}` : ''}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as RouteWithStepsResult;

    const best = await this.fetchRoute(origin, destination, waypoints, true);
    const steps: RouteStep[] = (best.legs ?? []).flatMap((leg) =>
      (leg.steps ?? []).map((step) => MapboxMapsClient.toRouteStep(step)),
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

  /** Pide UNA ruta a Directions (geometría polyline precision-5, igual que OSRM) y valida la respuesta. */
  private async fetchRoute(
    origin: LatLon,
    destination: LatLon,
    waypoints: readonly LatLon[],
    withSteps: boolean,
  ): Promise<MapboxRoute> {
    const coords = [origin, ...waypoints, destination].map((p) => `${p.lon},${p.lat}`).join(';');
    const params = new URLSearchParams({
      access_token: this.opts.accessToken,
      geometries: 'polyline',
      overview: 'full',
      language: 'es',
    });
    if (withSteps) params.set('steps', 'true');
    const url = `${this.baseUrl}/directions/v5/mapbox/${this.profile}/${coords}?${params.toString()}`;
    const body = await this.getJson<MapboxDirectionsResponse>(url, 'Mapbox directions');
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best) {
      throw new ExternalServiceError('Mapbox no devolvió ruta', { code: body.code });
    }
    return best;
  }

  /** Traduce un step de Mapbox (mismo `maneuver.type`/`modifier` que OSRM) a `RouteStep` normalizado. */
  private static toRouteStep(step: MapboxStep): RouteStep {
    const maneuver: RouteManeuver = MapboxMapsClient.normalizeManeuver(step.maneuver);
    return {
      instruction: buildInstruction(maneuver, step.name),
      distanceMeters: Math.round(step.distance),
      maneuver,
      geometryPolyline: step.geometry ?? '',
    };
  }

  /**
   * Mapea (type, modifier) de Mapbox a nuestro `RouteManeuver`. Mapbox comparte el vocabulario de OSRM
   * (es OSRM bajo el capó) y añade `end of road`, `on ramp`/`off ramp` y `exit roundabout/rotary`.
   */
  private static normalizeManeuver(maneuver: OsrmStepManeuver | undefined): RouteManeuver {
    const type = maneuver?.type ?? '';
    const modifier = maneuver?.modifier ?? '';
    switch (type) {
      case OsrmManeuverType.DEPART:
        return 'depart';
      case OsrmManeuverType.ARRIVE:
        return 'arrive';
      case OsrmManeuverType.ROUNDABOUT:
      case OsrmManeuverType.ROTARY:
      case OsrmManeuverType.ROUNDABOUT_TURN:
      case OsrmManeuverType.EXIT_ROUNDABOUT:
      case OsrmManeuverType.EXIT_ROTARY:
        return 'roundabout';
      case OsrmManeuverType.MERGE:
      case OsrmManeuverType.ON_RAMP:
        return 'merge';
      case OsrmManeuverType.FORK:
        return 'fork';
      case OsrmManeuverType.CONTINUE:
      case OsrmManeuverType.NEW_NAME:
      case OsrmManeuverType.NOTIFICATION:
        return 'straight';
      default:
        return MapboxMapsClient.modifierToManeuver(modifier);
    }
  }

  private static modifierToManeuver(modifier: string): RouteManeuver {
    switch (modifier) {
      case OsrmManeuverModifier.LEFT:
        return 'turn-left';
      case OsrmManeuverModifier.RIGHT:
        return 'turn-right';
      case OsrmManeuverModifier.SLIGHT_LEFT:
        return 'turn-slight-left';
      case OsrmManeuverModifier.SLIGHT_RIGHT:
        return 'turn-slight-right';
      case OsrmManeuverModifier.SHARP_LEFT:
        return 'turn-sharp-left';
      case OsrmManeuverModifier.SHARP_RIGHT:
        return 'turn-sharp-right';
      case OsrmManeuverModifier.UTURN:
        return 'uturn';
      default:
        return 'straight';
    }
  }

  async eta(origin: LatLon, destination: LatLon): Promise<number> {
    return (await this.route(origin, destination)).durationSeconds;
  }

  /** Fallback de ETA (s) por gran-círculo (24 km/h × 1.3 sinuosidad), igual que OSRM/local. */
  private static fallbackEta(origin: LatLon, destination: LatLon): number {
    const AVG_SPEED_MS = (24 * 1000) / 3600;
    const DETOUR_FACTOR = 1.3;
    const meters = distanceMeters(origin, destination) * DETOUR_FACTOR;
    return Math.round(meters / AVG_SPEED_MS);
  }

  /**
   * ETA en LOTE en UNA request a la Matrix API (sustituye el N×`route` del broadcast). Layout:
   * `[...origins, destination]`, `sources=0..N-1` y un único `destinations=N`; `durations[i][0]` es la
   * duración del origen i al destino común. Un par null cae al fallback de gran-círculo; si TODA la
   * request falla, TODO el lote cae al fallback (no rompe el broadcast). Alineado con `origins`.
   *
   * Nota: el perfil `driving-traffic` de Matrix admite máx. 10 coordenadas; si el lote excede el
   * límite usamos `driving` (sin tráfico) para resolver la matriz completa en una sola pasada.
   */
  async etaBatch(origins: readonly LatLon[], destination: LatLon): Promise<number[]> {
    if (origins.length === 0) return [];

    const points = [...origins, destination];
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
    const destIndex = origins.length;
    const sources = origins.map((_, i) => i).join(';');
    // driving-traffic tope 10 coords; por encima caemos a driving para no fragmentar la request.
    const matrixProfile = points.length > 10 ? 'driving' : this.profile;
    // `sources` usa ';' como separador (igual que el path de coords): lo construimos a mano para no
    // percent-codificarlo. El resto de params (access_token) van por URLSearchParams.
    const params = new URLSearchParams({ access_token: this.opts.accessToken });
    const url =
      `${this.baseUrl}/directions-matrix/v1/mapbox/${matrixProfile}/${coords}` +
      `?sources=${sources}&destinations=${destIndex}&annotations=duration&${params.toString()}`;

    try {
      const body = await this.getJson<MapboxMatrixResponse>(url, 'Mapbox matrix');
      if (body.code !== 'Ok' || !body.durations) {
        throw new ExternalServiceError('Mapbox matrix no devolvió matriz', { code: body.code });
      }
      return origins.map((origin, i) => {
        const seconds = body.durations?.[i]?.[0];
        return typeof seconds === 'number'
          ? Math.round(seconds)
          : MapboxMapsClient.fallbackEta(origin, destination);
      });
    } catch {
      return origins.map((origin) => MapboxMapsClient.fallbackEta(origin, destination));
    }
  }

  // ── Geocoding (Geocoding API v6) ──

  async geocode(query: string): Promise<GeocodeResult | null> {
    const cacheKey = `mbx:geocode:${query.toLowerCase()}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult;

    const features = await this.forward(query, { limit: 1 });
    const first = features[0];
    if (!first) return null;
    const result = MapboxMapsClient.toGeocode(first);
    if (!result) return null;
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  async autocomplete(query: string, opts: AutocompleteOptions = {}): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    // El BFF ya corta en <3; protegemos también la capa de datos.
    if (trimmed.length < 3) return [];

    const limit = opts.limit ?? 6;
    const countryCodes = opts.countryCodes ?? this.defaultCountry;
    const cacheKey = `mbx:autocomplete:${countryCodes}:${limit}:${
      opts.near ? `${opts.near.lat.toFixed(3)},${opts.near.lon.toFixed(3)}:` : ''
    }${trimmed.toLowerCase()}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult[];

    const features = await this.forward(trimmed, {
      limit,
      countryCodes,
      near: opts.near,
      autocomplete: true,
    });
    const results = features
      .map((feature) => MapboxMapsClient.toGeocode(feature))
      .filter((r): r is GeocodeResult => r !== null);
    await this.opts.cache?.set(cacheKey, JSON.stringify(results), this.cacheTtl);
    return results;
  }

  /** Forward geocoding v6. Normaliza tildes (Mapbox tolera ambas, pero estabiliza la clave de caché). */
  private async forward(
    query: string,
    opts: {
      limit: number;
      countryCodes?: string;
      near?: LatLon;
      autocomplete?: boolean;
    },
  ): Promise<MapboxFeature[]> {
    const params = new URLSearchParams({
      access_token: this.opts.accessToken,
      q: MapboxMapsClient.normalize(query),
      country: opts.countryCodes ?? this.defaultCountry,
      limit: String(Math.min(opts.limit, 10)),
      language: 'es',
      autocomplete: opts.autocomplete ? 'true' : 'false',
    });
    // Sesgo por proximidad: prioriza resultados cercanos a `near` (sin filtrar duro).
    if (opts.near) params.set('proximity', `${opts.near.lon},${opts.near.lat}`);
    const url = `${this.baseUrl}/search/geocode/v6/forward?${params.toString()}`;
    const body = await this.getJson<MapboxGeocodeResponse>(url, 'Mapbox geocode');
    return body.features ?? [];
  }

  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    const cacheKey = `mbx:reverse:${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    const cached = await this.opts.cache?.get(cacheKey);
    if (cached) return JSON.parse(cached) as GeocodeResult;

    const params = new URLSearchParams({
      access_token: this.opts.accessToken,
      longitude: String(point.lon),
      latitude: String(point.lat),
      language: 'es',
      limit: '1',
    });
    const url = `${this.baseUrl}/search/geocode/v6/reverse?${params.toString()}`;
    const body = await this.getJson<MapboxGeocodeResponse>(url, 'Mapbox reverse');
    const first = body.features?.[0];
    if (!first) return null;
    const result = MapboxMapsClient.toGeocode(first);
    if (!result) return null;
    await this.opts.cache?.set(cacheKey, JSON.stringify(result), this.cacheTtl);
    return result;
  }

  /**
   * Mapea un Feature de Mapbox v6 a `GeocodeResult` (el shape del puerto, idéntico a Nominatim):
   *  - lat/lon: `properties.coordinates` (preferido, más preciso) o `geometry.coordinates [lon,lat]`.
   *  - displayName: `full_address` → `place_formatted` → `name` (dirección legible completa).
   *  - name: `name` (nombre corto del lugar), si lo entrega.
   * Devuelve `null` si el feature no trae coordenadas usables.
   */
  private static toGeocode(feature: MapboxFeature): GeocodeResult | null {
    const props = feature.properties ?? {};
    const coords = props.coordinates;
    const geo = feature.geometry?.coordinates;
    const lat = coords?.latitude ?? geo?.[1];
    const lon = coords?.longitude ?? geo?.[0];
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    const displayName = props.full_address ?? props.place_formatted ?? props.name ?? '';
    return {
      lat,
      lon,
      displayName,
      name: props.name,
    };
  }

  /** Quita tildes/diacríticos (NFD + strip de marcas combinantes Unicode). Determinista. */
  private static normalize(text: string): string {
    return text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  private async getJson<T>(url: string, what: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 4000);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
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
