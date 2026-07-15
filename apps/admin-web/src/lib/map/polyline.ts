/**
 * Decodificador de polilíneas codificadas (algoritmo de Google/OSRM, precisión 5 — default OSRM).
 * El admin-bff entrega `routePolyline` (detalle de viaje) como cadena codificada; acá se convierte a
 * coordenadas [lon, lat] listas para la línea GeoJSON del MapView. Copia local del decoder de
 * `@veo/maps` (mismo algoritmo que family-web): admin-web no depende del paquete de motores de ruteo.
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
