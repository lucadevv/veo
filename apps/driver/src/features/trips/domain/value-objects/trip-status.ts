import {tripStatus, type TripStatus} from '@veo/api-client';

/** Estado de viaje normalizado para la UI (incluye `UNKNOWN` para valores no reconocidos). */
export type DriverTripStatus = TripStatus | 'UNKNOWN';

/** Convierte el `status` crudo del viaje (string) al enum del contrato (o `UNKNOWN`). */
export function parseTripStatus(raw: string): DriverTripStatus {
  const parsed = tripStatus.safeParse(raw);
  return parsed.success ? parsed.data : 'UNKNOWN';
}

/** true si el conductor aún puede actuar sobre el viaje (no terminó ni se canceló). */
export function isTripActive(status: DriverTripStatus): boolean {
  return status !== 'COMPLETED' && status !== 'CANCELLED' && status !== 'UNKNOWN';
}
