/**
 * Eje Booking.estado — máquina de estados de la RESERVA del pasajero. ADR-014 §4.2.
 * El cobro charge-on-approval es ASÍNCRONO: el estado intermedio COBRO_PENDIENTE es el corazón de la
 * corrección consciente al spec (aprobado, pero el dinero AÚN no capturó — webhook/poll en vuelo).
 *
 * Caminos (ADR-014 §4.2):
 *   crear (modo REVISION)  → SOLICITADO → PENDIENTE_APROBACION
 *   crear (modo INSTANT)   → APROBADO            (SALTA PENDIENTE_APROBACION)
 *   PENDIENTE_APROBACION ──conductor aprueba──► APROBADO
 *   PENDIENTE_APROBACION ──conductor rechaza──► RECHAZADO   (terminal, no se cobró nada)
 *   PENDIENTE_APROBACION ──TTL ~5min vence──►   EXPIRADO    (terminal, no se cobró nada)
 *   APROBADO ──dispara CHARGE (async, dedupKey)──► COBRO_PENDIENTE   (asiento NO decrementa todavía)
 *   COBRO_PENDIENTE ──[payment.captured]──► CONFIRMADO   (txn atómica §6: lock + decremento de asiento — F3b · PENDIENTE)
 *   COBRO_PENDIENTE ──[payment.failed perm. / asiento-lleno]──► CANCELADO   (Refund — F3b · PENDIENTE)
 *   CONFIRMADO ──viaje arranca──► EN_RUTA ──► COMPLETADO
 *   CONFIRMADO ──pasajero/conductor cancela──► CANCELADO   (booking.cancelled con tier → Refund — F3/F5)
 *
 * F0 ejercita la CREACIÓN: SOLICITADO→PENDIENTE_APROBACION (REVISION) o APROBADO directo (INSTANT). El
 * resto de las transiciones (aprobar/rechazar/cobro/confirmar) se ejercita en F1-F3; la TABLA las codifica
 * COMPLETAS desde ya (la máquina es del eje, no de los endpoints de hoy) para que ninguna sea "un bug" sino
 * una transición imposible por construcción.
 *
 * NOTA de degradación honesta: el consumer de payment.captured/payment.failed que disparará
 * COBRO_PENDIENTE→CONFIRMADO/CANCELADO es F3b y AÚN NO EXISTE (pendiente). La tabla YA permite esas
 * transiciones; lo que se difiere es el HANDLER que las gatilla, no la legalidad de la transición. Hoy esas
 * transiciones NO se ejercitan en runtime: ningún código las dispara hasta que F3b se construya.
 */
import { BookingState } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas de la reserva. Única fuente de verdad del eje (ADR-014 §4.2). */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = {
  [BookingState.SOLICITADO]: [
    BookingState.PENDIENTE_APROBACION, // modo REVISION
    BookingState.APROBADO, // modo INSTANT (salta PENDIENTE_APROBACION)
    BookingState.CANCELADO,
  ],
  [BookingState.PENDIENTE_APROBACION]: [
    BookingState.APROBADO, // conductor aprueba
    BookingState.RECHAZADO, // conductor rechaza (terminal)
    BookingState.EXPIRADO, // TTL ~5min (terminal)
    BookingState.CANCELADO, // el pasajero cancela su solicitud
  ],
  [BookingState.APROBADO]: [
    BookingState.COBRO_PENDIENTE, // dispara CHARGE async (§5)
    BookingState.CANCELADO,
  ],
  [BookingState.COBRO_PENDIENTE]: [
    BookingState.CONFIRMADO, // payment.captured → txn atómica §6 (F3)
    BookingState.CANCELADO, // payment.failed perm. / asiento-lleno → Refund (F3)
  ],
  [BookingState.RECHAZADO]: [], // terminal
  [BookingState.EXPIRADO]: [], // terminal
  [BookingState.CONFIRMADO]: [
    BookingState.EN_RUTA, // el viaje arranca
    BookingState.CANCELADO, // cancelación con tier → Refund (F3/F5)
  ],
  [BookingState.EN_RUTA]: [BookingState.COMPLETADO],
  [BookingState.COMPLETADO]: [], // terminal
  [BookingState.CANCELADO]: [], // terminal
};

/** Máquina del eje Booking.estado. Toda mutación del eje pasa por `assertTransition`. */
export const bookingMachine: StateMachine<BookingState> = createStateMachine(
  'estado de la reserva',
  BOOKING_TRANSITIONS,
);
