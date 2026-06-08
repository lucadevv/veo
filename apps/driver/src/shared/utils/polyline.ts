/** Coordenada {latitude, longitude}. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Decodifica una polyline codificada (algoritmo de Google, precisión 1e-5) a coordenadas.
 * El bff entrega la geometría de la ruta en este formato. Implementación pura, sin deps.
 * Devuelve [] si la cadena es nula/vacía o inválida.
 */
export function decodePolyline(encoded: string | null | undefined): LatLng[] {
  if (!encoded) {
    return [];
  }

  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const length = encoded.length;

  while (index < length) {
    let result = 1;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < length);
    lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < length);
    lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    points.push({latitude: lat * 1e-5, longitude: lng * 1e-5});
  }

  return points;
}

/**
 * Decodifica una polyline codificada a posiciones GeoJSON [lng, lat] listas para MapLibre.
 * Devuelve [] si la cadena es nula/vacía.
 */
export function decodePolylineToCoordinates(
  encoded: string | null | undefined,
): [number, number][] {
  return decodePolyline(encoded).map(({latitude, longitude}) => [longitude, latitude]);
}
