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

/** Mapea (type, modifier) de OSRM a nuestro `RouteManeuver` normalizado. */
export function normalizeManeuver(maneuver: OsrmStepManeuver | undefined): RouteManeuver {
  const type = maneuver?.type ?? '';
  const modifier = maneuver?.modifier ?? '';
  switch (type) {
    case 'depart':
      return 'depart';
    case 'arrive':
      return 'arrive';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return 'roundabout';
    case 'merge':
      return 'merge';
    case 'fork':
      return 'fork';
    case 'continue':
    case 'new name':
      return 'straight';
    default:
      return modifierToManeuver(modifier);
  }
}

function modifierToManeuver(modifier: string): RouteManeuver {
  switch (modifier) {
    case 'left':
      return 'turn-left';
    case 'right':
      return 'turn-right';
    case 'slight left':
      return 'turn-slight-left';
    case 'slight right':
      return 'turn-slight-right';
    case 'sharp left':
      return 'turn-sharp-left';
    case 'sharp right':
      return 'turn-sharp-right';
    case 'uturn':
      return 'uturn';
    case 'straight':
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
