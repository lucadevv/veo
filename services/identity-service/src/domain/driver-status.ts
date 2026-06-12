/**
 * Eje Driver.currentStatus — máquina de estados del TURNO del conductor.
 *
 * Camino feliz del turno: OFFLINE → AVAILABLE (solo vía gate biométrico de startShift) →
 * ASSIGNED → ON_TRIP → AVAILABLE … → OFFLINE.
 *
 * Reglas que la tabla codifica:
 *  - El turno SOLO arranca desde OFFLINE (→ AVAILABLE); no hay atajo desde SUSPENDED.
 *  - ON_BREAK requiere turno activo: OFFLINE → ON_BREAK es inválida (no hay pausa sin turno).
 *  - Desde cualquier estado EN TURNO se puede ir a OFFLINE (fin de turno) o a SUSPENDED
 *    (una suspensión puede caer en cualquier momento del turno).
 *  - SUSPENDED solo sale hacia OFFLINE (el regreso al turno exige re-pasar el gate biométrico).
 *
 * ASSIGNED/ON_TRIP los mueve el ciclo de dispatch/viaje; identity los lista para que la tabla
 * cubra el enum COMPLETO (la máquina es del eje, no de los endpoints que identity expone hoy).
 */
import { DriverStatus } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas del turno. Única fuente de verdad del eje. */
export const DRIVER_STATUS_TRANSITIONS: Readonly<Record<DriverStatus, readonly DriverStatus[]>> = {
  [DriverStatus.OFFLINE]: [DriverStatus.AVAILABLE],
  [DriverStatus.AVAILABLE]: [
    DriverStatus.ASSIGNED,
    DriverStatus.ON_BREAK,
    DriverStatus.OFFLINE,
    DriverStatus.SUSPENDED,
  ],
  [DriverStatus.ASSIGNED]: [
    DriverStatus.ON_TRIP,
    DriverStatus.AVAILABLE,
    DriverStatus.OFFLINE,
    DriverStatus.SUSPENDED,
  ],
  [DriverStatus.ON_TRIP]: [
    DriverStatus.AVAILABLE,
    DriverStatus.OFFLINE,
    DriverStatus.SUSPENDED,
  ],
  [DriverStatus.ON_BREAK]: [
    DriverStatus.AVAILABLE,
    DriverStatus.OFFLINE,
    DriverStatus.SUSPENDED,
  ],
  [DriverStatus.SUSPENDED]: [DriverStatus.OFFLINE],
};

/** Máquina del eje Driver.currentStatus. Toda mutación del eje pasa por `assertTransition`. */
export const driverStatusMachine: StateMachine<DriverStatus> = createStateMachine(
  'estado del conductor',
  DRIVER_STATUS_TRANSITIONS,
);

/**
 * Estados que el propio conductor puede pedir por REST (fin de turno / pausa).
 * AVAILABLE queda EXCLUIDO a propósito: la vuelta a disponible pasa SIEMPRE por el gate
 * biométrico de startShift — un futuro endpoint "resume" no puede saltárselo vía setStatus.
 */
export type SelfServiceDriverStatus = Extract<
  DriverStatus,
  typeof DriverStatus.OFFLINE | typeof DriverStatus.ON_BREAK
>;
