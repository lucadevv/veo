import { describe, it, expect } from 'vitest';
import { MapboxMapsClient } from './mapbox-client.js';
import { InMemoryMapsCache } from './cache.js';

const PLAZA_MAYOR = { lat: -12.0464, lon: -77.0428 };
const MIRAFLORES = { lat: -12.1211, lon: -77.0297 };
const TOKEN = 'pk.test';

/** Helper: fetch mockeado que captura la última URL y devuelve un cuerpo JSON fijo. */
function mockFetch(body: unknown, capture?: (url: string) => void): typeof fetch {
  return (async (url: string) => {
    capture?.(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('MapboxMapsClient · constructor', () => {
  it('exige accessToken', () => {
    expect(() => new MapboxMapsClient({ accessToken: '' })).toThrow();
  });
});

describe('MapboxMapsClient · autocomplete', () => {
  it('arma forward v6 con proximity (near), country=pe, language=es y mapea features a GeocodeResult', async () => {
    let requestedUrl = '';
    const fetchImpl = mockFetch(
      {
        type: 'FeatureCollection',
        features: [
          {
            geometry: { type: 'Point', coordinates: [-77.0291, -12.1133] },
            properties: {
              name: 'Avenida Larco',
              full_address: 'Avenida Larco, Miraflores, Lima, Perú',
              place_formatted: 'Miraflores, Lima, Perú',
              coordinates: { longitude: -77.0291, latitude: -12.1133 },
            },
          },
          {
            geometry: { type: 'Point', coordinates: [-77.03, -12.1] },
            properties: {
              name: 'Parque Kennedy',
              full_address: 'Parque Kennedy, Miraflores, Lima',
              coordinates: { longitude: -77.03, latitude: -12.1 },
            },
          },
        ],
      },
      (url) => {
        requestedUrl = url;
      },
    );
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });

    const results = await client.autocomplete('Larco', { near: MIRAFLORES, limit: 6 });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      lat: -12.1133,
      lon: -77.0291,
      displayName: 'Avenida Larco, Miraflores, Lima, Perú',
      name: 'Avenida Larco',
    });
    // Forward v6 endpoint + sesgo por proximidad (lon,lat) + país + idioma + autocomplete.
    expect(requestedUrl).toContain('/search/geocode/v6/forward');
    expect(requestedUrl).toContain(
      `proximity=${encodeURIComponent(`${MIRAFLORES.lon},${MIRAFLORES.lat}`)}`,
    );
    expect(requestedUrl).toContain('country=pe');
    expect(requestedUrl).toContain('language=es');
    expect(requestedUrl).toContain('autocomplete=true');
    expect(requestedUrl).toContain('access_token=pk.test');
  });

  it('devuelve [] cuando el texto es muy corto (<3) sin pegar a la API', async () => {
    const fetchImpl = (async () => {
      throw new Error('no debería pegar a Mapbox');
    }) as unknown as typeof fetch;
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    expect(await client.autocomplete('Av')).toEqual([]);
  });

  it('normaliza tildes en el query (Jirón → Jiron) para estabilizar la búsqueda', async () => {
    let requestedUrl = '';
    const fetchImpl = mockFetch({ type: 'FeatureCollection', features: [] }, (url) => {
      requestedUrl = url;
    });
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    await client.autocomplete('Jirón Sol de Oro');
    // URLSearchParams codifica espacios como '+'; lo importante es que las tildes desaparecieron.
    expect(requestedUrl).toContain('q=Jiron');
    expect(requestedUrl).not.toContain('Jir%C3%B3n');
  });
});

describe('MapboxMapsClient · reverse', () => {
  it('arma reverse v6 con longitude/latitude y mapea el primer feature', async () => {
    let requestedUrl = '';
    const fetchImpl = mockFetch(
      {
        type: 'FeatureCollection',
        features: [
          {
            geometry: { type: 'Point', coordinates: [-77.0428, -12.0464] },
            properties: {
              name: 'Plaza Mayor',
              full_address: 'Plaza Mayor, Cercado de Lima, Lima, Perú',
              coordinates: { longitude: -77.0428, latitude: -12.0464 },
            },
          },
        ],
      },
      (url) => {
        requestedUrl = url;
      },
    );
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });

    const result = await client.reverse(PLAZA_MAYOR);
    expect(result).toEqual({
      lat: -12.0464,
      lon: -77.0428,
      displayName: 'Plaza Mayor, Cercado de Lima, Lima, Perú',
      name: 'Plaza Mayor',
    });
    expect(requestedUrl).toContain('/search/geocode/v6/reverse');
    expect(requestedUrl).toContain(`longitude=${PLAZA_MAYOR.lon}`);
    expect(requestedUrl).toContain(`latitude=${PLAZA_MAYOR.lat}`);
  });

  it('devuelve null cuando no hay features', async () => {
    const fetchImpl = mockFetch({ type: 'FeatureCollection', features: [] });
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    expect(await client.reverse(PLAZA_MAYOR)).toBeNull();
  });
});

describe('MapboxMapsClient · geocode', () => {
  it('devuelve el primer match y cachea (segunda lectura no pega a la API)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              geometry: { type: 'Point', coordinates: [-77.0291, -12.1133] },
              properties: {
                name: 'Av. Arequipa 1000',
                full_address: 'Av. Arequipa 1000, Lima',
                coordinates: { longitude: -77.0291, latitude: -12.1133 },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const cache = new InMemoryMapsCache();
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl, cache });

    const first = await client.geocode('Av Arequipa 1000');
    expect(first?.lat).toBe(-12.1133);
    const second = await client.geocode('Av Arequipa 1000');
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });
});

describe('MapboxMapsClient · routeWithSteps (Directions v5)', () => {
  it('pide steps=true a driving-traffic y normaliza maniobras + instrucción es-PE', async () => {
    let requestedUrl = '';
    const fetchImpl = mockFetch(
      {
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
                    distance: 200,
                    geometry: '_mqNvxq`@',
                    name: 'Vía Expresa',
                    maneuver: { type: 'on ramp', modifier: 'slight left' },
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
      },
      (url) => {
        requestedUrl = url;
      },
    );
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });

    const result = await client.routeWithSteps(PLAZA_MAYOR, MIRAFLORES);
    expect(requestedUrl).toContain('/directions/v5/mapbox/driving-traffic/');
    expect(requestedUrl).toContain('steps=true');
    expect(requestedUrl).toContain('geometries=polyline');
    expect(result.distanceMeters).toBe(10800);
    expect(result.durationSeconds).toBe(1620);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0]?.maneuver).toBe('depart');
    expect(result.steps[1]?.maneuver).toBe('turn-right');
    expect(result.steps[1]?.instruction).toBe('Gira a la derecha en Av. Larco');
    // `on ramp` (propio de Mapbox, no en OSRM) → merge.
    expect(result.steps[2]?.maneuver).toBe('merge');
    expect(result.steps[3]?.maneuver).toBe('arrive');
    // La geometría GeoJSON se deriva de la polyline (overview=full).
    expect(result.geometry.type).toBe('LineString');
    expect(result.geometry.coordinates.length).toBeGreaterThan(0);
  });
});

describe('MapboxMapsClient · etaBatch (Matrix v1)', () => {
  it('usa UNA request a Matrix con sources=0;1 y un destino, mapea durations[i][0]', async () => {
    let calls = 0;
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      calls += 1;
      requestedUrl = url;
      return new Response(JSON.stringify({ code: 'Ok', durations: [[180], [300]] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });

    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    expect(calls).toBe(1);
    expect(requestedUrl).toContain('/directions-matrix/v1/mapbox/');
    expect(requestedUrl).toContain('sources=0;1');
    expect(requestedUrl).toContain('destinations=2');
    expect(requestedUrl).toContain('annotations=duration');
    expect(result).toEqual([180, 300]);
  });

  it('un par null cae al fallback de gran-círculo (no rompe el lote)', async () => {
    const fetchImpl = mockFetch({ code: 'Ok', durations: [[180], [null]] });
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    expect(result[0]).toBe(180);
    expect(typeof result[1]).toBe('number');
    expect(result[1]).toBeGreaterThan(0);
  });

  it('si TODA la request falla, todo el lote cae al fallback (no rompe el broadcast)', async () => {
    const fetchImpl = (async () => {
      throw new Error('Mapbox caído');
    }) as unknown as typeof fetch;
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    const SAN_ISIDRO = { lat: -12.0976, lon: -77.0365 };
    const result = await client.etaBatch([PLAZA_MAYOR, SAN_ISIDRO], MIRAFLORES);
    expect(result).toHaveLength(2);
    expect(result.every((s) => typeof s === 'number' && s >= 0)).toBe(true);
  });

  it('[] devuelve []', async () => {
    const fetchImpl = mockFetch({ code: 'Ok', durations: [] });
    const client = new MapboxMapsClient({ accessToken: TOKEN, fetchImpl });
    expect(await client.etaBatch([], MIRAFLORES)).toEqual([]);
  });
});
