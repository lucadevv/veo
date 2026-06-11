/**
 * Lote C1 — Parada mid-trip NEGOCIADA (dominio PURO, sin I/O).
 *
 * El pasajero propone una parada DURANTE el viaje (IN_PROGRESS). Se calcula el delta de tarifa y la
 * ruta nueva, se crea una PROPUESTA con timeout, y el conductor la acepta o rechaza. Server-authoritative:
 * el pasajero NO fija la tarifa — el server computa el delta y lo estampa al aceptar (BR-T01/BR-T05).
 *
 * Este módulo aloja SOLO lógica determinista y testeable sin DB ni mapas:
 *   - `WaypointProposalStatus`: estados TIPADOS de la propuesta (§4-ter, cero strings mágicos).
 *   - La máquina de transiciones (PROPOSED → ACCEPTED|REJECTED|EXPIRED; los terminales no transicionan).
 *   - `computeFareDelta`: el delta en céntimos entre la tarifa nueva (ruta con la parada) y la actual.
 *   - `isExpired`: ¿venció el TTL de la propuesta respecto a un reloj dado?
 *
 * Coincide 1:1 con el enum Prisma `WaypointProposalStatus` (schema.prisma) — sin drift.
 */
import { InvalidStateError } from '@veo/utils';

/**
 * Estados de una propuesta de parada mid-trip. PROPOSED es el único estado VIVO; los demás son
 * terminales (una propuesta resuelta no vuelve a moverse). Misma forma const-as-enum que `TripStatus`
 * de @veo/shared-types (§4-ter: estados tipados, nunca strings sueltos).
 */
export const WaypointProposalStatus = {
  /** Propuesta abierta esperando respuesta del conductor (vive hasta `expiresAt`). */
  PROPOSED: 'PROPOSED',
  /** El conductor aceptó: el waypoint se agregó al viaje y la tarifa se actualizó (terminal). */
  ACCEPTED: 'ACCEPTED',
  /** El conductor rechazó la parada (terminal). */
  REJECTED: 'REJECTED',
  /** Nadie respondió antes del TTL; el sweeper la expiró (terminal). */
  EXPIRED: 'EXPIRED',
} as const;
export type WaypointProposalStatus =
  (typeof WaypointProposalStatus)[keyof typeof WaypointProposalStatus];

/**
 * Tabla de transiciones. Única fuente de verdad: solo PROPOSED transiciona; los terminales mapean a
 * conjunto vacío. Cualquier transición no listada lanza InvalidWaypointProposalTransition.
 */
export const WAYPOINT_PROPOSAL_TRANSITIONS: Readonly<
  Record<WaypointProposalStatus, readonly WaypointProposalStatus[]>
> = {
  [WaypointProposalStatus.PROPOSED]: [
    WaypointProposalStatus.ACCEPTED,
    WaypointProposalStatus.REJECTED,
    WaypointProposalStatus.EXPIRED,
  ],
  [WaypointProposalStatus.ACCEPTED]: [],
  [WaypointProposalStatus.REJECTED]: [],
  [WaypointProposalStatus.EXPIRED]: [],
};

/** Error específico de transición inválida de la propuesta de parada (subclase de InvalidStateError). */
export class InvalidWaypointProposalTransition extends InvalidStateError {
  constructor(from: WaypointProposalStatus, to: WaypointProposalStatus) {
    super(`Transición de propuesta de parada inválida: ${from} → ${to}`, { from, to });
  }
}

/** Estados terminales de la propuesta (sin transiciones de salida). */
export const WAYPOINT_PROPOSAL_TERMINAL: ReadonlySet<WaypointProposalStatus> = new Set(
  (Object.keys(WAYPOINT_PROPOSAL_TRANSITIONS) as WaypointProposalStatus[]).filter(
    (s) => WAYPOINT_PROPOSAL_TRANSITIONS[s].length === 0,
  ),
);

/** ¿Es válida la transición `from → to`? */
export function canTransition(
  from: WaypointProposalStatus,
  to: WaypointProposalStatus,
): boolean {
  return WAYPOINT_PROPOSAL_TRANSITIONS[from].includes(to);
}

/** ¿Es terminal el estado de la propuesta? (resuelta: ACCEPTED|REJECTED|EXPIRED). */
export function isTerminal(status: WaypointProposalStatus): boolean {
  return WAYPOINT_PROPOSAL_TERMINAL.has(status);
}

/**
 * Verifica que `from → to` sea válida; si no, lanza InvalidWaypointProposalTransition.
 * Es la guarda que toda mutación de estado de la propuesta debe invocar.
 */
export function assertTransition(
  from: WaypointProposalStatus,
  to: WaypointProposalStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidWaypointProposalTransition(from, to);
  }
}

/**
 * Delta de tarifa de agregar la parada: tarifa de la ruta NUEVA (con la parada appendeada) menos la
 * tarifa ACTUAL del viaje. Ambas en céntimos enteros (dinero en enteros, regla dura). Puede ser
 * negativo en teoría (rutas raras del motor); el caller decide si lo permite. Es resta pura de enteros.
 */
export function computeFareDelta(newFareCents: number, currentFareCents: number): number {
  return newFareCents - currentFareCents;
}

/** ¿La propuesta venció su TTL respecto a `now`? (expiresAt en el pasado o igual a now). */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
