import {tripStatus, type TripStatus} from '@veo/api-client';

/** Estado de viaje normalizado para la UI (incluye `UNKNOWN` para valores no reconocidos). */
export type DriverTripStatus = TripStatus | 'UNKNOWN';

/** Convierte el `status` crudo del viaje (string) al enum del contrato (o `UNKNOWN`). */
export function parseTripStatus(raw: string): DriverTripStatus {
  const parsed = tripStatus.safeParse(raw);
  return parsed.success ? parsed.data : 'UNKNOWN';
}

/**
 * Estados en los que el viaje ya NO le pertenece al conductor: cierres con o sin éxito
 * (COMPLETED/CANCELLED), cierres del watchdog (EXPIRED por inactividad, FAILED) y REASSIGNING
 * (el conductor liberó el viaje y vuelve al dispatch → para él se terminó). El compilador verifica
 * exhaustividad contra `DriverTripStatus`, así un estado nuevo del contrato no queda sin clasificar.
 */
export function isTripTerminal(status: DriverTripStatus): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'CANCELLED' ||
    status === 'EXPIRED' ||
    status === 'FAILED' ||
    status === 'REASSIGNING'
  );
}

/**
 * true si el conductor aún puede ACTUAR sobre el viaje. Es el complemento de un viaje terminal o
 * desconocido: antes solo excluía COMPLETED/CANCELLED y dejaba EXPIRED/FAILED/REASSIGNING como si
 * siguieran activos (raíz del hallazgo #4: la UI gateaba mal y el viaje terminal seguía "vivo").
 */
export function isTripActive(status: DriverTripStatus): boolean {
  return status !== 'UNKNOWN' && !isTripTerminal(status);
}
