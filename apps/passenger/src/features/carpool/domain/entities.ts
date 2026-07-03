import type {BookingState} from '@veo/api-client';

/**
 * Reglas y helpers PUROS del carpooling (lado pasajero). Sin dependencias de UI ni de red, para
 * poder testearlos de forma determinista (mismo criterio que `scheduleSlots.ts` del feature trip).
 */

/** Asientos mínimos/máximos que se pueden buscar/reservar (espeja el contrato del wire: 1..8). */
export const CARPOOL_MIN_SEATS = 1;
export const CARPOOL_MAX_SEATS = 8;

/** Largo máximo del mensaje de presentación al conductor (espeja `mensajeIntro` ≤500 del wire). */
export const CARPOOL_MESSAGE_MAX = 500;

/** Días de calendario ofrecidos en el selector de fecha de la búsqueda (hoy + 13 = 2 semanas). */
export const CARPOOL_SEARCH_HORIZON_DAYS = 14;

/** Un día seleccionable del buscador (fecha calendario, sin hora). */
export interface CarpoolDayOption {
  /** Día en formato YYYY-MM-DD (lo que viaja como `fecha` al bff). */
  iso: string;
  /** Día del mes (1-31), para la etiqueta corta del chip. */
  dayOfMonth: number;
  /** Índice de día de la semana (0=domingo), para la etiqueta corta del chip. */
  weekday: number;
}

/** YYYY-MM-DD local de una fecha (sin Intl: Hermes/Jest-safe). */
export function toLocalIsoDay(date: Date): string {
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Días seleccionables de la búsqueda: desde HOY hasta el horizonte. A diferencia del selector de
 * viajes programados (ventana dura de 7 días del trip-service), acá el límite es solo de UI: el
 * carpooling intercity se publica con más anticipación y el server no impone techo a la búsqueda.
 */
export function carpoolDayOptions(
  now: Date = new Date(),
  horizonDays: number = CARPOOL_SEARCH_HORIZON_DAYS,
): CarpoolDayOption[] {
  const days: CarpoolDayOption[] = [];
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + offset,
    );
    days.push({
      iso: toLocalIsoDay(date),
      dayOfMonth: date.getDate(),
      weekday: date.getDay(),
    });
  }
  return days;
}

/**
 * Buckets de PRESENTACIÓN del estado de la reserva (Pqorm/htFHZ/q6Z6Xa del pen): una sola pantalla
 * de estado decide su variante acá, no con `if` de strings sueltos por la UI.
 *  - pending: esperando la decisión del conductor (se sigue POLLEANDO).
 *  - approved: aprobada — el cobro está en vuelo (APROBADO/COBRO_PENDIENTE) o ya capturó
 *    (CONFIRMADO y posteriores: el viaje sigue su curso normal).
 *  - rejected: no se concretó (rechazo/expiración/cancelación) — NO hubo cobro (verdad del ADR-014:
 *    el CHARGE se dispara recién al aprobar).
 */
export type CarpoolBookingPhase = 'pending' | 'approved' | 'rejected';

export function bookingPhase(state: BookingState): CarpoolBookingPhase {
  switch (state) {
    case 'SOLICITADO':
    case 'PENDIENTE_APROBACION':
      return 'pending';
    case 'APROBADO':
    case 'COBRO_PENDIENTE':
    case 'CONFIRMADO':
    case 'EN_RUTA':
    case 'COMPLETADO':
      return 'approved';
    case 'RECHAZADO':
    case 'EXPIRADO':
    case 'CANCELADO':
      return 'rejected';
  }
}

/** ¿El cobro ya CAPTURÓ? (CONFIRMADO+). Antes de eso el dinero está "en proceso" (honestidad). */
export function bookingCharged(state: BookingState): boolean {
  return (
    state === 'CONFIRMADO' || state === 'EN_RUTA' || state === 'COMPLETADO'
  );
}
