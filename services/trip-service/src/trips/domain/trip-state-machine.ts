/**
 * BR-T02 — Máquina de estados determinista del viaje.
 *
 * Camino feliz:
 *   (SCHEDULED →) REQUESTED → ASSIGNED → ACCEPTED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED
 *
 * SCHEDULED (Ola 2B): estado inicial de un viaje PROGRAMADO (con scheduledFor futuro). El scheduler
 * lo activa transicionándolo a REQUESTED a la hora (menos el lead time); también puede cancelarse
 * con antelación (CANCELLED_BY_PASSENGER) o expirar (EXPIRED) si el scheduler no pudo activarlo.
 *
 * Terminales: COMPLETED, CANCELLED_BY_PASSENGER, CANCELLED_BY_DRIVER, FAILED.
 *
 * EXPIRED YA NO es terminal (ADR 010 #12 · H6.4): tras una puja sin ofertas el pasajero puede
 * RE-PUJAR (EXPIRED → REQUESTED) y reactivar la negociación a un nuevo bid, en vez de crear un viaje
 * nuevo desde cero. Igual desde REASSIGNING el pasajero puede subir el bid explícitamente
 * (REASSIGNING → REQUESTED) sin esperar el re-match automático (decisión #4, "subir al re-abrir").
 *
 * PUJA / reasignación (ADR 010 §3.1, decisión #4): cuando el conductor cancela DESPUÉS de aceptar
 * (ACCEPTED / ARRIVING / ARRIVED) el viaje NO termina en CANCELLED_BY_DRIVER; pasa a REASSIGNING y
 * re-abre la puja (cierra el catastrófico #4 — pasajero abandonado). REASSIGNING no es terminal:
 *   REASSIGNING → ASSIGNED (re-match) | EXPIRED (sin ofertas) | CANCELLED_BY_PASSENGER (se rinde).
 * El cancel del conductor desde ASSIGNED (aún NO aceptó) sigue siendo terminal CANCELLED_BY_DRIVER.
 *
 * La tabla de transiciones es la única fuente de verdad. Cualquier transición no listada
 * lanza InvalidTripTransition (subclase de InvalidStateError de @veo/utils).
 */
import { InvalidStateError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';

/** Error específico de transición inválida de la máquina de estados del viaje. */
export class InvalidTripTransition extends InvalidStateError {
  constructor(from: TripStatus, to: TripStatus) {
    super(`Transición de viaje inválida: ${from} → ${to}`, { from, to });
  }
}

/**
 * Tabla de transiciones válidas. Cada estado mapea al conjunto de estados a los que puede pasar.
 * Los estados terminales mapean a un conjunto vacío.
 */
export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
  // Viaje programado (Ola 2B): el scheduler lo activa (→ REQUESTED) o el pasajero lo cancela con
  // antelación; EXPIRED cubre el caso de que el scheduler no pueda activarlo (p.ej. ventana vencida).
  [TripStatus.SCHEDULED]: [
    TripStatus.REQUESTED,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.EXPIRED,
  ],
  [TripStatus.REQUESTED]: [
    TripStatus.ASSIGNED,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.EXPIRED,
    TripStatus.FAILED,
  ],
  [TripStatus.ASSIGNED]: [
    TripStatus.ACCEPTED,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.CANCELLED_BY_DRIVER,
    TripStatus.EXPIRED,
    TripStatus.FAILED,
  ],
  // Post-accept: si el conductor cancela, NO termina (CANCELLED_BY_DRIVER) — pasa a REASSIGNING y
  // re-abre la puja (ADR 010 #4). El pasajero aún puede cancelar (CANCELLED_BY_PASSENGER).
  [TripStatus.ACCEPTED]: [
    TripStatus.ARRIVING,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.REASSIGNING,
    TripStatus.FAILED,
  ],
  [TripStatus.ARRIVING]: [
    TripStatus.ARRIVED,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.REASSIGNING,
    TripStatus.FAILED,
  ],
  [TripStatus.ARRIVED]: [
    TripStatus.IN_PROGRESS,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.REASSIGNING,
    TripStatus.FAILED,
  ],
  [TripStatus.IN_PROGRESS]: [TripStatus.COMPLETED, TripStatus.FAILED],
  // Reasignación (ADR 010 §3.1): la puja re-abierta vuelve a ASSIGNED (re-match), EXPIRED (sin
  // ofertas en la ventana) o CANCELLED_BY_PASSENGER (el pasajero se rinde). NO es terminal.
  // RE-BID (ADR 010 #4 · H6.4): el pasajero puede RE-PUJAR explícitamente (subir el bid) sin esperar
  // un re-match — vuelve a REQUESTED y se abre un board fresco al nuevo bid.
  [TripStatus.REASSIGNING]: [
    TripStatus.REQUESTED,
    TripStatus.ASSIGNED,
    TripStatus.EXPIRED,
    TripStatus.CANCELLED_BY_PASSENGER,
    TripStatus.FAILED,
  ],
  [TripStatus.COMPLETED]: [],
  [TripStatus.CANCELLED_BY_PASSENGER]: [],
  [TripStatus.CANCELLED_BY_DRIVER]: [],
  // RE-BID (ADR 010 #12 · H6.4): EXPIRED ya NO es callejón sin salida — el pasajero puede RE-PUJAR
  // (→ REQUESTED) y reactivar la puja con un nuevo bid en vez de crear un viaje nuevo desde cero.
  [TripStatus.EXPIRED]: [TripStatus.REQUESTED],
  [TripStatus.FAILED]: [],
};

/** Estados terminales (sin transiciones de salida). */
export const TERMINAL_STATES: ReadonlySet<TripStatus> = new Set(
  (Object.keys(TRIP_TRANSITIONS) as TripStatus[]).filter(
    (s) => TRIP_TRANSITIONS[s].length === 0,
  ),
);

/**
 * Estados "VIVOS": un viaje EN CURSO de negociación o ejecución al que el pasajero debe poder volver
 * (re-entrada al flujo unificado) y que, mientras exista, impide pedir otro ("una sola experiencia").
 * Vivo = NO terminal, NO programado (SCHEDULED se lista aparte) y NO EXPIRED.
 *
 * EXPIRED queda FUERA a propósito: una puja que expiró sin conseguir conductor NO es "un viaje en
 * curso" — en la práctica se abandona. Tratarla como viva BLOQUEARÍA pedir un viaje nuevo (409) y
 * resucitaría pujas muertas en la re-entrada, atrapando al pasajero. El re-bid (EXPIRED → REQUESTED)
 * sigue existiendo como acción EXPLÍCITA (desde el historial), no como un estado activo que retiene.
 * REASSIGNING SÍ es vivo: ahí hay un viaje real cuyo conductor canceló y se está re-matcheando.
 */
export const LIVE_STATES: ReadonlySet<TripStatus> = new Set(
  (Object.keys(TRIP_TRANSITIONS) as TripStatus[]).filter(
    (s) =>
      !TERMINAL_STATES.has(s) && s !== TripStatus.SCHEDULED && s !== TripStatus.EXPIRED,
  ),
);

/** ¿Es válida la transición `from → to`? */
export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].includes(to);
}

/**
 * Estados DESDE los que `to` es alcanzable (inversa de la tabla). Pensado para guards CAS atómicos:
 * `updateMany({ where: { id, status: { in: transitionSources(to) } }, ... })` mueve el estado en el
 * MISMO statement que lo valida — sin check-then-act. Deriva de TRIP_TRANSITIONS (única fuente de
 * verdad): si la tabla cambia, el guard la sigue. Determinista (orden de la tabla) para reproducibilidad.
 */
export function transitionSources(to: TripStatus): TripStatus[] {
  return (Object.keys(TRIP_TRANSITIONS) as TripStatus[]).filter((from) => canTransition(from, to));
}

/** ¿Es terminal el estado? */
export function isTerminal(status: TripStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** ¿Es un viaje VIVO (en curso, re-entrable)? Ver LIVE_STATES. */
export function isLive(status: TripStatus): boolean {
  return LIVE_STATES.has(status);
}

/**
 * Verifica que `from → to` sea válida; si no, lanza InvalidTripTransition.
 * Es la guarda que toda mutación de estado del servicio debe invocar.
 */
export function assertTransition(from: TripStatus, to: TripStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTripTransition(from, to);
  }
}
