/**
 * Eje AdminUser.status — ciclo de vida del operador del panel admin.
 *
 *  - PENDING → ACTIVE | REJECTED: un ADMIN aprueba (asigna roles) o rechaza el auto-registro.
 *  - ACTIVE → SUSPENDED | REJECTED: se suspende o se revoca a un operador activo.
 *  - SUSPENDED → ACTIVE | REJECTED: se rehabilita o se revoca definitivamente.
 *  - REJECTED → ACTIVE: re-evaluación aprobada (hoy el operador puede re-aprobar un rechazo,
 *    y ese flujo se preserva).
 * Prohibido: volver a PENDING una solicitud ya decidida.
 */
import { AdminStatus } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas del operador admin. */
export const ADMIN_STATUS_TRANSITIONS: Readonly<Record<AdminStatus, readonly AdminStatus[]>> = {
  [AdminStatus.PENDING]: [AdminStatus.ACTIVE, AdminStatus.REJECTED],
  [AdminStatus.ACTIVE]: [AdminStatus.SUSPENDED, AdminStatus.REJECTED],
  [AdminStatus.SUSPENDED]: [AdminStatus.ACTIVE, AdminStatus.REJECTED],
  [AdminStatus.REJECTED]: [AdminStatus.ACTIVE],
};

/** Máquina del eje AdminUser.status. */
export const adminStatusMachine: StateMachine<AdminStatus> = createStateMachine(
  'estado del operador admin',
  ADMIN_STATUS_TRANSITIONS,
);

/**
 * ¿El operador puede operar el panel? La pregunta que login/step-up hacían con
 * `admin.status !== 'ACTIVE'` desparramada; ahora vive acá.
 */
export function isOperationalAdmin(admin: { status: AdminStatus }): boolean {
  return admin.status === AdminStatus.ACTIVE;
}
