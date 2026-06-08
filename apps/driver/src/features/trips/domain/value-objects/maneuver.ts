import type {RouteManeuver} from '@veo/api-client';

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
