import type { GeoPoint } from '@veo/api-client';

/**
 * Helpers geográficos locales (sin `@veo/utils`, que usa `node:crypto`/`h3-js` no aptos para
 * Hermes). Bounding box de Lima Metropolitana (zona operativa) y centro por defecto para
 * encuadrar el mapa cuando aún no hay fix de GPS.
 */
export const LIMA_BBOX = {
  minLat: -12.52,
  maxLat: -11.57,
  minLon: -77.2,
  maxLon: -76.7,
} as const;

/** Centro aproximado de Lima (Plaza San Martín) para el encuadre inicial del mapa. */
export const LIMA_CENTER: GeoPoint = { lat: -12.0464, lon: -77.0428 };

/** Centro de Lima en orden GeoJSON [lng, lat] (el que consume MapLibre). */
export const LIMA_CENTER_LNGLAT: [number, number] = [LIMA_CENTER.lon, LIMA_CENTER.lat];

/** Zoom inicial razonable para encuadrar el área metropolitana en MapLibre. */
export const LIMA_ZOOM = 12;

/** Convierte un `GeoPoint` (lat/lon) a la posición GeoJSON [lng, lat] de MapLibre. */
export function toLngLat(point: GeoPoint): [number, number] {
  return [point.lon, point.lat];
}

/** Recuadro (bounds) en formato MapLibre a partir de una lista de posiciones [lng, lat]. */
export interface LngLatBounds {
  ne: [number, number];
  sw: [number, number];
}

/**
 * Calcula el bounding box que contiene todas las posiciones [lng, lat] dadas.
 * Devuelve `null` si la lista está vacía (el llamador centra por defecto).
 */
export function boundsOf(positions: ReadonlyArray<[number, number]>): LngLatBounds | null {
  let acc: { minLng: number; maxLng: number; minLat: number; maxLat: number } | null = null;
  for (const [lng, lat] of positions) {
    if (!acc) {
      acc = { minLng: lng, maxLng: lng, minLat: lat, maxLat: lat };
      continue;
    }
    if (lng < acc.minLng) acc.minLng = lng;
    if (lng > acc.maxLng) acc.maxLng = lng;
    if (lat < acc.minLat) acc.minLat = lat;
    if (lat > acc.maxLat) acc.maxLat = lat;
  }
  if (!acc) {
    return null;
  }
  return { ne: [acc.maxLng, acc.maxLat], sw: [acc.minLng, acc.minLat] };
}

/** True si el punto está dentro del bounding box de Lima Metropolitana. */
export function isWithinLima(point: GeoPoint): boolean {
  return (
    point.lat >= LIMA_BBOX.minLat &&
    point.lat <= LIMA_BBOX.maxLat &&
    point.lon >= LIMA_BBOX.minLon &&
    point.lon <= LIMA_BBOX.maxLon
  );
}
