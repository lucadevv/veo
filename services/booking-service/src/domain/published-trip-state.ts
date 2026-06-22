/**
 * Eje PublishedTrip.estado — máquina de estados de la OFERTA del conductor. ADR-014 §4.1.
 *
 * Camino feliz de la oferta:
 *   BORRADOR ──publicar──► PUBLICADO ──(1er booking CONFIRMADO)──► PARCIALMENTE_RESERVADO
 *   PUBLICADO/PARCIALMENTE_RESERVADO ──(asientosDisponibles==0)──► LLENO
 *   LLENO ──(cancela un pasajero, libera asiento)──► PARCIALMENTE_RESERVADO
 *   PUBLICADO/PARCIALMENTE_RESERVADO/LLENO ──(fechaHoraSalida llega)──► EN_RUTA ──► COMPLETADO
 *   * (cualquier estado pre-EN_RUTA) ──(conductor/admin cancela)──► CANCELADO
 *
 * Reglas que la tabla codifica (ADR-014 §4.1):
 *  - La oferta SOLO se publica desde BORRADOR (→ PUBLICADO). En F0 el create publica directo (BORRADOR→PUBLICADO).
 *  - PARCIALMENTE_RESERVADO y LLENO los mueve el ciclo de bookings CONFIRMADOS (decremento de asientos, §6 — F3).
 *  - LLENO puede volver a PARCIALMENTE_RESERVADO si un pasajero cancela y libera un asiento.
 *  - EN_RUTA se alcanza desde cualquier estado con cupo (al llegar fechaHoraSalida → emite booking.started, F4).
 *  - CANCELADO es alcanzable desde cualquier estado PRE-viaje (no desde EN_RUTA/COMPLETADO).
 *
 * Las transiciones que dependen de bookings (PARCIALMENTE_RESERVADO/LLENO), del reloj (EN_RUTA) y de la
 * cancelación masiva (CANCELADO) se LISTAN acá para que la tabla cubra el enum COMPLETO — la máquina es del
 * EJE, no de los endpoints que F0 expone hoy. F0 ejercita BORRADOR→PUBLICADO; el resto es F1-F4.
 */
import { PublishedTripState } from '../generated/prisma';
import { createStateMachine, type StateMachine } from './state-machine';

/** Tabla de transiciones válidas de la oferta. Única fuente de verdad del eje (ADR-014 §4.1). */
export const PUBLISHED_TRIP_TRANSITIONS: Readonly<
  Record<PublishedTripState, readonly PublishedTripState[]>
> = {
  [PublishedTripState.BORRADOR]: [PublishedTripState.PUBLICADO, PublishedTripState.CANCELADO],
  [PublishedTripState.PUBLICADO]: [
    PublishedTripState.PARCIALMENTE_RESERVADO,
    PublishedTripState.LLENO,
    PublishedTripState.EN_RUTA,
    PublishedTripState.CANCELADO,
  ],
  [PublishedTripState.PARCIALMENTE_RESERVADO]: [
    PublishedTripState.LLENO,
    PublishedTripState.EN_RUTA,
    PublishedTripState.CANCELADO,
  ],
  [PublishedTripState.LLENO]: [
    // libera asiento si un pasajero cancela (LLENO → PARCIALMENTE_RESERVADO)
    PublishedTripState.PARCIALMENTE_RESERVADO,
    PublishedTripState.EN_RUTA,
    PublishedTripState.CANCELADO,
  ],
  [PublishedTripState.EN_RUTA]: [PublishedTripState.COMPLETADO],
  [PublishedTripState.COMPLETADO]: [], // terminal
  [PublishedTripState.CANCELADO]: [], // terminal
};

/** Máquina del eje PublishedTrip.estado. Toda mutación del eje pasa por `assertTransition`. */
export const publishedTripMachine: StateMachine<PublishedTripState> = createStateMachine(
  'estado del viaje publicado',
  PUBLISHED_TRIP_TRANSITIONS,
);

/**
 * Conjunto de estados DESDE los que una transición a `target` es legal, DERIVADO de la tabla (única fuente
 * de verdad) — NO una lista de strings sueltos. Lo consume el UPDATE atómico condicionado por estado (F1
 * FIX 1): el `where: { estado: { in: statesThatCanTransitionTo(CANCELADO) } }` garantiza que el write solo
 * aplique si la PRIMARIA sigue en un estado desde el que la transición es válida. Si la tabla cambia, esta
 * lista cambia con ella (cero drift).
 */
export function statesThatCanTransitionTo(
  target: PublishedTripState,
): readonly PublishedTripState[] {
  return (Object.keys(PUBLISHED_TRIP_TRANSITIONS) as PublishedTripState[]).filter((from) =>
    PUBLISHED_TRIP_TRANSITIONS[from].includes(target),
  );
}

/**
 * Estados desde los que CANCELAR es legal (pre-EN_RUTA), derivados de la máquina. EDITAR, en cambio, es más
 * restrictivo que la máquina: solo PUBLICADO (sin reservas confirmadas) — esa regla la fija el service, no
 * la tabla de transiciones (editar no es un cambio de `estado`, es mutar otros campos manteniendo el estado).
 */
export const CANCELABLE_STATES: readonly PublishedTripState[] = statesThatCanTransitionTo(
  PublishedTripState.CANCELADO,
);

/**
 * Estados VISIBLES a la BÚSQUEDA del pasajero (F2, §6.2): una oferta es reservable mientras tiene cupo, lo
 * que abarca PUBLICADO (sin reservas aún) y PARCIALMENTE_RESERVADO (con cupo restante). Quedan FUERA:
 * BORRADOR (no publicada), LLENO (sin cupo), EN_RUTA/COMPLETADO (ya operando/terminada) y CANCELADO. Enum
 * TIPADO (cero strings mágicos) — fuente única del filtro `estado IN (...)` de la búsqueda. El filtro de
 * `asientosDisponibles >= asientos` complementa esto (un PARCIALMENTE_RESERVADO sin suficientes asientos
 * para el pasajero queda excluido por el cupo, no por el estado).
 */
export const SEARCHABLE_STATES: readonly PublishedTripState[] = [
  PublishedTripState.PUBLICADO,
  PublishedTripState.PARCIALMENTE_RESERVADO,
];
