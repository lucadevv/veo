import type { GeoJsonLineString } from './types.js';

/**
 * Decodifica una polyline codificada (algoritmo Google/OSRM) a coordenadas en orden
 * GeoJSON `[lon, lat]`. `precision` = número de decimales (OSRM usa 5 por defecto, 6 con polyline6).
 * Devuelve `[]` para cadenas vacías. No es un mock: es la decodificación estándar y determinista.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  if (!encoded) return [];

  const factor = Math.pow(10, precision);
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

/** Construye un GeoJSON LineString a partir de una polyline codificada. */
export function polylineToGeoJson(encoded: string, precision = 5): GeoJsonLineString {
  return { type: 'LineString', coordinates: decodePolyline(encoded, precision) };
}

/** Codifica un único valor (delta) al alfabeto de polyline (algoritmo Google/OSRM). */
function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/**
 * Codifica coordenadas en orden GeoJSON `[lon, lat]` a una polyline (algoritmo Google/OSRM).
 * Inversa exacta de `decodePolyline`. `precision` = número de decimales (OSRM usa 5 por defecto).
 * Devuelve `''` para listas vacías. No es un mock: es la codificación estándar y determinista.
 */
export function encodePolyline(coordinates: readonly [number, number][], precision = 5): string {
  if (coordinates.length === 0) return '';
  const factor = Math.pow(10, precision);
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lon, lat] of coordinates) {
    const latE = Math.round(lat * factor);
    const lngE = Math.round(lon * factor);
    out += encodeValue(latE - prevLat);
    out += encodeValue(lngE - prevLng);
    prevLat = latE;
    prevLng = lngE;
  }
  return out;
}
