/**
 * BR-T03 — Penalización por cancelación (lógica de dominio pura, sin I/O).
 *
 * Cancelación del PASAJERO:
 *   - Gratis si han pasado < 2 min desde assignedAt (ventana de gracia).
 *   - Gratis si el conductor lleva > 5 min de retraso respecto a su ETA de llegada.
 *   - En caso contrario: penalización de S/ 3.00 (300 céntimos).
 *   - Si aún no había conductor asignado (assignedAt nulo) → gratis.
 *
 * Cancelación del CONDUCTOR: el pasajero no paga penalización (las sanciones al conductor
 * se gestionan en otro flujo).
 */

/** Penalización estándar de cancelación: S/ 3.00. */
export const CANCELLATION_PENALTY_CENTS = 300;
/** Ventana de gracia tras la asignación: 2 minutos. */
export const FREE_CANCEL_WINDOW_MS = 2 * 60 * 1000;
/** Umbral de retraso del conductor que exime de penalización: 5 minutos. */
export const DRIVER_LATE_THRESHOLD_MS = 5 * 60 * 1000;

export type CancelActor = 'PASSENGER' | 'DRIVER' | 'SYSTEM';

export interface CancellationInput {
  by: CancelActor;
  /** Momento en que se asignó el conductor (null si seguía en REQUESTED). */
  assignedAt: Date | null;
  /** ETA de llegada del conductor al punto de recojo (null si se desconoce). */
  driverEta: Date | null;
  /** Momento de la cancelación. */
  now: Date;
}

/** Devuelve la penalización en céntimos PEN para la cancelación descrita. */
export function calculateCancellationPenalty(input: CancellationInput): number {
  const { by, assignedAt, driverEta, now } = input;

  // Solo el pasajero puede incurrir en penalización en este flujo.
  if (by !== 'PASSENGER') return 0;

  // Sin conductor asignado todavía → cancelación gratuita.
  if (!assignedAt) return 0;

  // Ventana de gracia de 2 minutos desde la asignación.
  if (now.getTime() - assignedAt.getTime() < FREE_CANCEL_WINDOW_MS) return 0;

  // Conductor con más de 5 minutos de retraso respecto a su ETA → cancelación gratuita.
  if (driverEta && now.getTime() - driverEta.getTime() > DRIVER_LATE_THRESHOLD_MS) return 0;

  return CANCELLATION_PENALTY_CENTS;
}
