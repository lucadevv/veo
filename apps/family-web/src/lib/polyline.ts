/**
 * Decodificador de polilíneas codificadas (algoritmo de Google/OSRM).
 * El public-bff entrega routePolyline como cadena codificada con precisión 5 (default OSRM).
 * Devuelve coordenadas [lon, lat] listas para una fuente GeoJSON de MapLibre.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  if (!encoded) return [];

  const factor = Math.pow(10, precision);
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lon / factor, lat / factor]);
  }

  return coordinates;
}
