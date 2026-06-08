/**
 * Geoespacial sobre H3 (Uber) — base del dispatch (BR-T06, blueprint §08).
 * Resolución 9 ≈ celdas de ~174m de arista, buen balance para matching urbano en Lima.
 */
import { latLngToCell, cellToLatLng, gridDisk, greatCircleDistance, getResolution } from 'h3-js';

export interface LatLon {
  lat: number;
  lon: number;
}

/** Resolución H3 por defecto para el hot index de dispatch. */
export const DISPATCH_H3_RESOLUTION = 9;

export function toH3(point: LatLon, resolution: number = DISPATCH_H3_RESOLUTION): string {
  return latLngToCell(point.lat, point.lon, resolution);
}

export function fromH3(cell: string): LatLon {
  const [lat, lon] = cellToLatLng(cell);
  return { lat, lon };
}

/**
 * Celdas vecinas dentro de `k` anillos (k=1 → 7 celdas, k=2 → 19, …).
 * Usado para expandir el radio de búsqueda cuando los primeros conductores rechazan (BR-T06).
 */
export function neighbors(cell: string, k: number): string[] {
  return gridDisk(cell, k);
}

/** Distancia en metros entre dos puntos (gran círculo). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  return greatCircleDistance([a.lat, a.lon], [b.lat, b.lon], 'm');
}

export function h3Resolution(cell: string): number {
  return getResolution(cell);
}

/** Bounding box aproximado de Lima Metropolitana (BR-D03: zona permitida). */
export const LIMA_BBOX = {
  minLat: -12.52,
  maxLat: -11.57,
  minLon: -77.2,
  maxLon: -76.7,
} as const;

export function isWithinLima(point: LatLon): boolean {
  return (
    point.lat >= LIMA_BBOX.minLat &&
    point.lat <= LIMA_BBOX.maxLat &&
    point.lon >= LIMA_BBOX.minLon &&
    point.lon <= LIMA_BBOX.maxLon
  );
}
