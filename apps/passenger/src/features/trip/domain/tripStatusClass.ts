import type {TripStatus} from '@veo/api-client';

/**
 * Clasificación del estado de un viaje para decidir la NAVEGACIÓN desde el historial (y para el tono de
 * la pastilla). PURA y testeable: el bug viejo era decidir esto con el `status` del snapshot MMKV (que
 * quedaba congelado en REQUESTED), así que TODO se trataba como "vivo" y navegaba a la pantalla legacy.
 * Ahora el estado viene del SERVER (`GET /trips/history`) y esta función decide honestamente.
 *
 * TERMINAL = el viaje acabó (de cualquier forma): solo cabe el detalle de solo-lectura, que se abre en un
 *            `DraggableSheet` SOBRE "Mis Viajes" (ver TripDetailSheet) — ya no es una pantalla aparte.
 * VIVO     = sigue en curso: se re-entra por el flujo unificado (sheet del Home), (la pantalla legacy `TripActive` se eliminó).
 */
export const TERMINAL_TRIP_STATUSES: ReadonlySet<TripStatus> =
  new Set<TripStatus>(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED']);

/** `true` si el viaje ya terminó (cualquier estado terminal). */
export function isTerminalTrip(status: TripStatus): boolean {
  return TERMINAL_TRIP_STATUSES.has(status);
}

/** `true` si el viaje sigue VIVO (no terminal) — se re-entra por el sheet, no por la pantalla legacy. */
export function isLiveTrip(status: TripStatus): boolean {
  return !isTerminalTrip(status);
}
