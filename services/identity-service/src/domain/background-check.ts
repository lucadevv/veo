/**
 * Eje Driver.backgroundCheckStatus — revisión de antecedentes del conductor (BR-I01).
 *
 * PENDING → CLEARED | REJECTED es la decisión del operador. Ningún estado es terminal:
 *  - CLEARED → REJECTED: revocación por hallazgo posterior.
 *  - REJECTED → CLEARED: re-evaluación/apelación aprobada (hoy el operador puede re-aprobar
 *    un rechazo, y ese flujo se preserva).
 * Lo que la tabla SÍ prohíbe: volver a PENDING una decisión ya tomada.
 */
import { BackgroundCheckStatus } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas de la revisión de antecedentes. */
export const BACKGROUND_CHECK_TRANSITIONS: Readonly<
  Record<BackgroundCheckStatus, readonly BackgroundCheckStatus[]>
> = {
  [BackgroundCheckStatus.PENDING]: [BackgroundCheckStatus.CLEARED, BackgroundCheckStatus.REJECTED],
  [BackgroundCheckStatus.CLEARED]: [BackgroundCheckStatus.REJECTED],
  [BackgroundCheckStatus.REJECTED]: [BackgroundCheckStatus.CLEARED],
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
