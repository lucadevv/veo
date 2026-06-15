/**
 * Normalización de maniobras y construcción de instrucciones legibles (es-PE) para la navegación
 * turn-by-turn (Ola 2C). Traduce el `maneuver` de OSRM (`type` + `modifier`) a un `RouteManeuver`
 * estable y arma una frase corta en español. Determinista y sin dependencias externas (soberanía).
 */
import type { RouteManeuver } from './types.js';

/** Forma del `maneuver` que entrega OSRM en cada step cuando `steps=true`. */
export interface OsrmStepManeuver {
  type?: string;
  modifier?: string;
}

/**
 * Vocabulario CRUDO de maniobras de OSRM/Mapbox (CONTRATO DEL MOTOR DE RUTEO, no dominio VEO). Vive en
 * el adaptador de mapas (§INTEGRACIONES: el adapter es dueño del lenguaje del proveedor; el dominio jamás
 * compara estos literales). `normalizeManeuver`/`modifierToManeuver` los TRADUCEN a `RouteManeuver`.
 * Mapbox comparte el vocab de OSRM y añade variantes (exit roundabout/rotary, on ramp, notification).
 * Fuente: OSRM/Mapbox Directions API (`maneuver.type` + `maneuver.modifier`).
 */
export const OsrmManeuverType = {
  DEPART: 'depart',
  ARRIVE: 'arrive',
  ROUNDABOUT: 'roundabout',
  ROTARY: 'rotary',
  ROUNDABOUT_TURN: 'roundabout turn',
  EXIT_ROUNDABOUT: 'exit roundabout',
  EXIT_ROTARY: 'exit rotary',
  MERGE: 'merge',
  ON_RAMP: 'on ramp',
  FORK: 'fork',
  CONTINUE: 'continue',
  NEW_NAME: 'new name',
  NOTIFICATION: 'notification',
} as const;

export const OsrmManeuverModifier = {
  LEFT: 'left',
  RIGHT: 'right',
  SLIGHT_LEFT: 'slight left',
  SLIGHT_RIGHT: 'slight right',
  SHARP_LEFT: 'sharp left',
  SHARP_RIGHT: 'sharp right',
  UTURN: 'uturn',
  STRAIGHT: 'straight',
} as const;

/** Mapea (type, modifier) de OSRM a nuestro `RouteManeuver` normalizado. */
export function normalizeManeuver(maneuver: OsrmStepManeuver | undefined): RouteManeuver {
  const type = maneuver?.type ?? '';
  const modifier = maneuver?.modifier ?? '';
  switch (type) {
    case OsrmManeuverType.DEPART:
      return 'depart';
    case OsrmManeuverType.ARRIVE:
      return 'arrive';
    case OsrmManeuverType.ROUNDABOUT:
    case OsrmManeuverType.ROTARY:
    case OsrmManeuverType.ROUNDABOUT_TURN:
      return 'roundabout';
    case OsrmManeuverType.MERGE:
      return 'merge';
    case OsrmManeuverType.FORK:
      return 'fork';
    case OsrmManeuverType.CONTINUE:
    case OsrmManeuverType.NEW_NAME:
      return 'straight';
    default:
      return modifierToManeuver(modifier);
  }
}

function modifierToManeuver(modifier: string): RouteManeuver {
  switch (modifier) {
    case OsrmManeuverModifier.LEFT:
      return 'turn-left';
    case OsrmManeuverModifier.RIGHT:
      return 'turn-right';
    case OsrmManeuverModifier.SLIGHT_LEFT:
      return 'turn-slight-left';
    case OsrmManeuverModifier.SLIGHT_RIGHT:
      return 'turn-slight-right';
    case OsrmManeuverModifier.SHARP_LEFT:
      return 'turn-sharp-left';
    case OsrmManeuverModifier.SHARP_RIGHT:
      return 'turn-sharp-right';
    case OsrmManeuverModifier.UTURN:
      return 'uturn';
    case OsrmManeuverModifier.STRAIGHT:
      return 'straight';
    default:
      return 'straight';
  }
}

/** Frase base por maniobra (es-PE), sin el nombre de la vía. */
const PHRASES: Record<RouteManeuver, string> = {
  depart: 'Inicia el recorrido',
  'turn-left': 'Gira a la izquierda',
  'turn-right': 'Gira a la derecha',
  'turn-slight-left': 'Mantente ligeramente a la izquierda',
  'turn-slight-right': 'Mantente ligeramente a la derecha',
  'turn-sharp-left': 'Gira cerrado a la izquierda',
  'turn-sharp-right': 'Gira cerrado a la derecha',
  uturn: 'Haz un cambio de sentido',
  straight: 'Continúa recto',
  merge: 'Incorpórate',
  roundabout: 'Toma la rotonda',
  fork: 'Mantente en el carril',
  arrive: 'Has llegado a tu destino',
};

/**
 * Construye una instrucción legible (es-PE) a partir de la maniobra normalizada y el nombre de la
 * vía (si OSRM lo entrega). Ej: `turn-right` + "Av. Larco" → "Gira a la derecha en Av. Larco".
 */
export function buildInstruction(maneuver: RouteManeuver, roadName?: string): string {
  const base = PHRASES[maneuver];
  const name = roadName?.trim();
  if (!name) return base;
  if (maneuver === 'arrive' || maneuver === 'depart') return `${base} por ${name}`;
  return `${base} en ${name}`;
}
