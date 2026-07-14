import type { GeoPoint, RouteManeuver } from '@veo/api-client';
import type { TripRouteStep } from '../entities';

/**
 * Tipo de maniobra de un paso de navegación (re-export del contrato para que la presentación
 * dependa del dominio, no del paquete de API). Los valores son los del motor de ruteo (OSRM-like).
 */
export type TripManeuver = RouteManeuver;

/**
 * Familia visual de la maniobra: agrupa los 13 tipos del contrato en un set pequeño de glifos
 * direccionales que la UI sabe dibujar (un ícono por familia). Mantener el mapeo en el dominio
 * lo hace probable sin renderizar y deja la pantalla declarativa.
 */
export type ManeuverGlyph =
  | 'straight'
  | 'left'
  | 'slight-left'
  | 'sharp-left'
  | 'right'
  | 'slight-right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'merge'
  | 'fork'
  | 'depart'
  | 'arrive';

/** Mapea un tipo de maniobra del contrato a su glifo direccional. Total (sin `default` perdido). */
export function maneuverGlyph(maneuver: TripManeuver): ManeuverGlyph {
  switch (maneuver) {
    case 'turn-left':
      return 'left';
    case 'turn-slight-left':
      return 'slight-left';
    case 'turn-sharp-left':
      return 'sharp-left';
    case 'turn-right':
      return 'right';
    case 'turn-slight-right':
      return 'slight-right';
    case 'turn-sharp-right':
      return 'sharp-right';
    case 'uturn':
      return 'uturn';
    case 'roundabout':
      return 'roundabout';
    case 'merge':
      return 'merge';
    case 'fork':
      return 'fork';
    case 'depart':
      return 'depart';
    case 'arrive':
      return 'arrive';
    case 'straight':
      return 'straight';
  }
}

/** `true` si la maniobra es el último paso (llegada al destino). */
export function isArrival(maneuver: TripManeuver): boolean {
  return maneuver === 'arrive';
}

/**
 * Extrae el nombre de la vía de la instrucción `arrive` del contrato. El BFF entrega la instrucción
 * ya ARMADA (buildInstruction de @veo/maps: "Has llegado a tu destino" ± " por {vía}"), no el
 * roadName crudo — por eso el cliente lo recupera del sufijo tras el conector " por ". Lo necesita
 * el banner para reemplazar el copy del arrive POR FASE (yendo al recojo el "destino" del tramo es
 * el punto de RECOJO, no el destino real) sin perder la calle cuando el contrato la trae.
 * Sin conector o con sufijo vacío → null (instrucción sin vía).
 */
export function arriveRoadName(instruction: string): string | null {
  const connector = ' por ';
  const at = instruction.indexOf(connector);
  if (at < 0) return null;
  const road = instruction.slice(at + connector.length).trim();
  return road.length > 0 ? road : null;
}

/**
 * Formatea la distancia de un paso para el banner de la próxima maniobra, en es-PE y pensado para
 * leerse de un vistazo mientras se maneja:
 *  - < 10 m → "Ahora" (estás encima de la maniobra)
 *  - < 1000 m → metros redondeados a la decena ("En 150 m")
 *  - ≥ 1000 m → kilómetros con un decimal ("En 1.2 km")
 */
export function formatManeuverDistance(distanceMeters: number): string {
  const meters = Math.max(0, distanceMeters);
  if (meters < 10) {
    return 'Ahora';
  }
  if (meters < 1000) {
    const rounded = Math.round(meters / 10) * 10;
    return `En ${rounded} m`;
  }
  const km = (meters / 1000).toFixed(1);
  return `En ${km} km`;
}

/** Distancia gran-círculo (haversine) en metros — para el contador VIVO a la próxima maniobra. */
export function greatCircleMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** La próxima maniobra a anunciar + su distancia (viva si hay GPS, la del contrato si no). */
export interface UpcomingManeuver {
  step: TripRouteStep;
  distanceMeters: number;
}

/**
 * Deriva la PRÓXIMA maniobra del banner con distancia VIVA (semántica OSRM: la maniobra del paso i
 * ocurre al INICIO del paso i, así que la que viene es la de `steps[1]`, ubicada al FINAL de la
 * geometría del paso ACTUAL `steps[0]`). Con la posición GPS del conductor, la distancia es
 * conductor→punto de maniobra recalculada en CADA tick (contador vivo, no el largo del tramo entero
 * congelado entre polls). Sin GPS (o sin geometría del tramo): cae al `distanceMeters` del contrato
 * — degradación honesta, el valor del último cálculo del server.
 *
 * Con UN solo paso (p. ej. `arrive` ya retrimado), la maniobra a anunciar es esa y su punto es el
 * final de su propia geometría.
 */
export function upcomingManeuver(
  steps: readonly TripRouteStep[],
  driverAt: GeoPoint | null,
  decodeStepEnd: (geometryPolyline: string) => GeoPoint | null,
): UpcomingManeuver | null {
  const current = steps[0];
  if (!current) return null;
  const step = steps[1] ?? current;
  if (!driverAt) return { step, distanceMeters: current.distanceMeters };
  const maneuverPoint = decodeStepEnd(current.geometryPolyline);
  if (!maneuverPoint) return { step, distanceMeters: current.distanceMeters };
  return { step, distanceMeters: greatCircleMeters(driverAt, maneuverPoint) };
}
