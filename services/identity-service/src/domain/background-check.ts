/**
 * Eje Driver.backgroundCheckStatus — revisión de antecedentes del conductor (BR-I01).
 *
 * PENDING → CLEARED | REJECTED es la decisión del operador. Ningún estado es terminal:
 *  - CLEARED → REJECTED: revocación por hallazgo posterior.
 *  - REJECTED → CLEARED: re-evaluación/apelación aprobada (el operador puede re-aprobar un rechazo).
 *  - REJECTED → PENDING: el conductor RECHAZADO corrige sus datos y REENVÍA a revisión (resubmit). Sin
 *    esta transición el rechazo era un dead-end (el conductor no podía volver a la cola de aprobación).
 * Lo que la tabla SÍ prohíbe: volver a PENDING desde CLEARED (una aprobación no "des-decide" sola).
 */
import { BackgroundCheckStatus } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas de la revisión de antecedentes. */
export const BACKGROUND_CHECK_TRANSITIONS: Readonly<
  Record<BackgroundCheckStatus, readonly BackgroundCheckStatus[]>
> = {
  [BackgroundCheckStatus.PENDING]: [BackgroundCheckStatus.CLEARED, BackgroundCheckStatus.REJECTED],
  [BackgroundCheckStatus.CLEARED]: [BackgroundCheckStatus.REJECTED],
  [BackgroundCheckStatus.REJECTED]: [BackgroundCheckStatus.CLEARED, BackgroundCheckStatus.PENDING],
};

/** Máquina del eje Driver.backgroundCheckStatus. */
export const backgroundCheckMachine: StateMachine<BackgroundCheckStatus> = createStateMachine(
  'revisión de antecedentes',
  BACKGROUND_CHECK_TRANSITIONS,
);

/** ¿Tiene los antecedentes aprobados? (la pregunta que el gate de turno hacía con `!== 'CLEARED'`). */
export function isBackgroundCleared(status: BackgroundCheckStatus): boolean {
  return status === BackgroundCheckStatus.CLEARED;
}
