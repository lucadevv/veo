import { describe, it, expect } from 'vitest';
import { decodePolyline, polylineToGeoJson } from './polyline.js';

describe('decodePolyline', () => {
  it('decodifica la polyline de ejemplo de Google a coordenadas [lon, lat]', () => {
    // Ejemplo canónico: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453).
    const coords = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual([-120.2, 38.5]);
    expect(coords[1]).toEqual([-120.95, 40.7]);
    expect(coords[2]).toEqual([-126.453, 43.252]);
  });

  it('devuelve [] para cadena vacía', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('polylineToGeoJson envuelve las coordenadas en un LineString', () => {
    const geo = polylineToGeoJson('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(geo.type).toBe('LineString');
    expect(geo.coordinates).toHaveLength(3);
  });
});
