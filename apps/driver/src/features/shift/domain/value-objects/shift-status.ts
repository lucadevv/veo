/**
 * Estado del turno del conductor, normalizado desde el `currentStatus` crudo que devuelve
 * identity-service (vía driver-bff). Valores reales del backend: OFFLINE, AVAILABLE, ON_BREAK, ON_TRIP.
 */
export type ShiftStatus = 'OFFLINE' | 'AVAILABLE' | 'ON_BREAK' | 'ON_TRIP' | 'UNKNOWN';

/** Convierte el string crudo del servidor a un `ShiftStatus` conocido (tolerante a desconocidos). */
export function parseShiftStatus(raw: string): ShiftStatus {
  switch (raw) {
    case 'OFFLINE':
    case 'AVAILABLE':
    case 'ON_BREAK':
    case 'ON_TRIP':
      return raw;
    default:
      return 'UNKNOWN';
  }
}

/** true si el conductor está en turno activo (disponible o en viaje). */
export function isOnShift(status: ShiftStatus): boolean {
  return status === 'AVAILABLE' || status === 'ON_TRIP';
}

/** true si puede iniciar/reanudar turno (requiere gate biométrico). */
export function canStartShift(status: ShiftStatus): boolean {
  return status === 'OFFLINE' || status === 'ON_BREAK' || status === 'UNKNOWN';
}
