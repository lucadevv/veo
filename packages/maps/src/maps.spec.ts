import { describe, it, expect } from 'vitest';
import { LocalMapsEngine } from './local-engine.js';
import { OsrmMapsClient } from './osrm-client.js';
import { InMemoryMapsCache } from './cache.js';

const PLAZA_MAYOR = { lat: -12.0464, lon: -77.0428 };
const MIRAFLORES = { lat: -12.1211, lon: -77.0297 };

describe('LocalMapsEngine', () => {
  it('estima distancia (con sinuosidad) y duración > 0', async () => {
    const engine = new LocalMapsEngine({ avgSpeedKmh: 24, detourFactor: 1.3 });
    const route = await engine.route(PLAZA_MAYOR, MIRAFLORES);
    // línea recta ≈ 8.3 km → con factor 1.3 ≈ 10.8 km
    expect(route.distanceMeters).toBeGreaterThan(9000);
    expect(route.distanceMeters).toBeLessThan(13000);
    expect(route.durationSeconds).toBeGreaterThan(0);
  });

  it('eta coincide con la duración de la ruta', async () => {
    const engine = new LocalMapsEngine();
    const route = await engine.route(PLAZA_MAYOR, MIRAFLORES);
    const eta = await engine.eta(PLAZA_MAYOR, MIRAFLORES);
    expect(eta).toBe(route.durationSeconds);
  });

  it('A1 · etaBatch mapea cada origen localmente (1 eta por origen, alineado y mismo valor que eta)', async () => {
    const engine = new LocalMapsEngine();
    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const origins = [PLAZA_MAYOR, MIRAFLORES, SAN_ISIDRO];
    const batch = await engine.etaBatch(origins, MIRAFLORES);
    expect(batch).toHaveLength(3);
    // Cada entrada coincide con el eta single del MISMO origen hacia el destino común.
    for (const [i, origin] of origins.entries()) {
      expect(batch[i]).toBe(await engine.eta(origin, MIRAFLORES));
    }
    // El origen == destino (MIRAFLORES) da 0s.
    expect(batch[1]).toBe(0);
  });

  it('A1 · etaBatch con [] devuelve []', async () => {
    const engine = new LocalMapsEngine();
    expect(await engine.etaBatch([], MIRAFLORES)).toEqual([]);
  });

  it('Ola 2B · con paradas, la distancia incluye los tramos y la geometría todos los puntos', async () => {
    const engine = new LocalMapsEngine();
    const WAYPOINT = { lat: -12.09, lon: -77.035 };
    const direct = await engine.route(PLAZA_MAYOR, MIRAFLORES);
    const withStop = await engine.route(PLAZA_MAYOR, MIRAFLORES, [WAYPOINT]);
    // Un desvío por una parada nunca acorta el recorrido (desigualdad triangular).
    expect(withStop.distanceMeters).toBeGreaterThanOrEqual(direct.distanceMeters);
    // origen + parada + destino = 3 vértices.
    expect(withStop.geometry.coordinates).toHaveLength(3);
  });

  it('Ola 2C · routeWithSteps devuelve pasos plausibles (depart…arrive) con polyline por tramo', async () => {
    const engine = new LocalMapsEngine();
    const WAYPOINT = { lat: -12.09, lon: -77.035 };
    const result = await engine.routeWithSteps(PLAZA_MAYOR, MIRAFLORES, [WAYPOINT]);
    // 2 tramos (origen→parada, parada→destino) + step de llegada = 3 pasos.
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.maneuver).toBe('depart');
    expect(result.steps.at(-1)?.maneuver).toBe('arrive');
    // Cada tramo (no el de llegada) tiene geometría codificada y distancia > 0.
    expect(result.steps[0]?.geometryPolyline.length).toBeGreaterThan(0);
    expect(result.steps[0]?.distanceMeters).toBeGreaterThan(0);
    // La base coincide con route() (mismos distancia/duración).
    const base = await engine.route(PLAZA_MAYOR, MIRAFLORES, [WAYPOINT]);
    expect(result.distanceMeters).toBe(base.distanceMeters);
  });
});

describe('OsrmMapsClient', () => {
  it('parsea la respuesta de OSRM y cachea el resultado', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          code: 'Ok',
          routes: [{ distance: 10800, duration: 1620, geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const cache = new InMemoryMapsCache();
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      cache,
      fetchImpl,
    });

    const first = await client.route(PLAZA_MAYOR, MIRAFLORES);
    expect(first.distanceMeters).toBe(10800);
    expect(first.durationSeconds).toBe(1620);
    expect(first.polyline).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@'); // polyline de ejemplo de Google
    // La geometría GeoJSON se deriva de la polyline (overview=full).
    expect(first.geometry.type).toBe('LineString');
    expect(first.geometry.coordinates.length).toBe(3);
    expect(first.geometry.coordinates[0]).toEqual([-120.2, 38.5]);

    const second = await client.route(PLAZA_MAYOR, MIRAFLORES);
    expect(second).toEqual(first);
    expect(calls).toBe(1); // segunda lectura vino del cache
  });

  it('Ola 2B · arma la URL OSRM con origen, paradas y destino (en orden)', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({ code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: '' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });
    const WAYPOINT = { lat: -12.09, lon: -77.035 };
    await client.route(PLAZA_MAYOR, MIRAFLORES, [WAYPOINT]);
    // OSRM espera lon,lat separados por ';' en orden origen;parada;destino.
    expect(requestedUrl).toContain(
      `${PLAZA_MAYOR.lon},${PLAZA_MAYOR.lat};${WAYPOINT.lon},${WAYPOINT.lat};${MIRAFLORES.lon},${MIRAFLORES.lat}`,
    );
  });

  it('Ola 2C · routeWithSteps pide steps=true y normaliza maniobras + instrucción es-PE', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          code: 'Ok',
          routes: [
            {
              distance: 10800,
              duration: 1620,
              geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
              legs: [
                {
                  steps: [
                    {
                      distance: 120,
                      geometry: '_p~iF~ps|U',
                      name: 'Jr. de la Unión',
                      maneuver: { type: 'depart', modifier: 'straight' },
                    },
                    {
                      distance: 300,
                      geometry: '_ulLnnqC',
                      name: 'Av. Larco',
                      maneuver: { type: 'turn', modifier: 'right' },
                    },
                    {
                      distance: 0,
                      geometry: '',
                      name: '',
                      maneuver: { type: 'arrive' },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });

    const result = await client.routeWithSteps(PLAZA_MAYOR, MIRAFLORES);
    expect(requestedUrl).toContain('steps=true');
    expect(result.distanceMeters).toBe(10800);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.maneuver).toBe('depart');
    expect(result.steps[1]?.maneuver).toBe('turn-right');
    expect(result.steps[1]?.instruction).toBe('Gira a la derecha en Av. Larco');
    expect(result.steps[2]?.maneuver).toBe('arrive');
  });

  it('A1 · etaBatch usa UNA request a /table y mapea durations[i][0] a cada origen (en orden)', async () => {
    let calls = 0;
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      calls += 1;
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          code: 'Ok',
          // 2 sources × 1 destination: durations[i][0] = duración del origen i al destino.
          durations: [[180], [300]],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });

    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    // UNA sola request (no N): clave de A1.
    expect(calls).toBe(1);
    // Pega al servicio /table con sources=0;1 y un único destino (índice 2 = el último punto).
    expect(requestedUrl).toContain('/table/v1/driving/');
    expect(requestedUrl).toContain('sources=0;1');
    expect(requestedUrl).toContain('destinations=2');
    // El layout pone origins primero y el destino al final.
    expect(requestedUrl).toContain(
      `${PLAZA_MAYOR.lon},${PLAZA_MAYOR.lat};${SAN_ISIDRO.lon},${SAN_ISIDRO.lat};${MIRAFLORES.lon},${MIRAFLORES.lat}`,
    );
    expect(result).toEqual([180, 300]);
  });

  it('A1 · etaBatch mapea un par null (OSRM sin ruta) al fallback de gran-círculo (no rompe el lote)', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ code: 'Ok', durations: [[180], [null]] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });
    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    expect(result[0]).toBe(180);
    // El null cayó al fallback: un número finito > 0 (no null/NaN), no rompió el array.
    expect(typeof result[1]).toBe('number');
    expect(result[1]).toBeGreaterThan(0);
    expect(result).toHaveLength(2);
  });

  it('A1 · etaBatch con la request entera fallando cae TODO al fallback (no rompe el broadcast)', async () => {
    const fetchImpl = (async () => {
      throw new Error('OSRM caído');
    }) as unknown as typeof fetch;
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });
    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    expect(result).toHaveLength(2);
    expect(result.every((s) => typeof s === 'number' && s >= 0)).toBe(true);
  });

  it('geocode devuelve null cuando Nominatim no encuentra nada', async () => {
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });
    expect(await client.geocode('lugar inexistente xyz')).toBeNull();
  });

  it('autocomplete mapea la lista de Nominatim a GeocodeResult (con name y proximidad)', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify([
          { lat: '-12.1133', lon: '-77.0290', display_name: 'Av. Larco, Miraflores, Lima', name: 'Av. Larco' },
          { lat: '-12.1000', lon: '-77.0300', display_name: 'Parque Kennedy, Miraflores', name: 'Parque Kennedy' },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });

    const results = await client.autocomplete('Larco', { near: MIRAFLORES, limit: 6 });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      lat: -12.1133,
      lon: -77.029,
      displayName: 'Av. Larco, Miraflores, Lima',
      name: 'Av. Larco',
    });
    // Incluye el sesgo por proximidad (viewbox) y el país.
    expect(requestedUrl).toContain('countrycodes=pe');
    expect(requestedUrl).toContain('viewbox=');
  });

  it('autocomplete devuelve [] cuando el texto es muy corto (<3)', async () => {
    const fetchImpl = (async () => {
      throw new Error('no debería pegar a Nominatim');
    }) as unknown as typeof fetch;
    const client = new OsrmMapsClient({
      osrmBaseUrl: 'http://osrm:5000',
      nominatimBaseUrl: 'http://nominatim:8080',
      fetchImpl,
    });
    expect(await client.autocomplete('Av')).toEqual([]);
  });
});
