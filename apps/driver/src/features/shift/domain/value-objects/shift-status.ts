import { DriverStatus } from '@veo/shared-types';

/**
 * Estado del turno del conductor, normalizado desde el `currentStatus` crudo que devuelve
 * identity-service (vía driver-bff). Es el enum CANÓNICO `DriverStatus` (@veo/shared-types) +
 * `UNKNOWN` como fallback honesto para valores que el contrato aún no enumere. Antes faltaban
 * `ASSIGNED` y `SUSPENDED` y caían a `UNKNOWN`, lo que dejaba a un conductor SUSPENDIDO iniciar turno.
 */
export type ShiftStatus = DriverStatus | 'UNKNOWN';

/** Valores conocidos (los del enum canónico). Un string fuera de aquí es `UNKNOWN`. */
const KNOWN: ReadonlySet<string> = new Set(Object.values(DriverStatus));

/** Convierte el string crudo del servidor a un `ShiftStatus` conocido (tolerante a desconocidos). */
export function parseShiftStatus(raw: string): ShiftStatus {
  return KNOWN.has(raw) ? (raw as DriverStatus) : 'UNKNOWN';
}

/** true si el conductor está en turno activo (disponible, asignado o en viaje). */
export function isOnShift(status: ShiftStatus): boolean {
  return (
    status === DriverStatus.AVAILABLE ||
    status === DriverStatus.ASSIGNED ||
    status === DriverStatus.ON_TRIP
  );
}

/**
 * true si puede iniciar/reanudar turno (requiere gate biométrico). SOLO desde OFFLINE o ON_BREAK.
 * SUSPENDED jamás (regla de seguridad: un suspendido no opera) y UNKNOWN tampoco (conservador: no se
 * arranca un turno desde un estado que no reconocemos).
 */
export function canStartShift(status: ShiftStatus): boolean {
  return status === DriverStatus.OFFLINE || status === DriverStatus.ON_BREAK;
}

/** true si el conductor está SUSPENDIDO por la operación (no puede operar; la UI debe avisarlo). */
export function isSuspended(status: ShiftStatus): boolean {
  return status === DriverStatus.SUSPENDED;
}
