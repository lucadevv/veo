/**
 * Fábrica de máquinas de estado del booking-service (mismo PATRÓN tipado que identity/trip-service —
 * ADR-014 §1 "reusa el patrón, no el código"). El marketplace tiene DOS ejes de estado:
 * PublishedTripState (la oferta) y BookingState (la reserva), y cada uno declara su tabla
 * `Record<Estado, Estado[]>` (única fuente de verdad) y obtiene `canTransition`/`assertTransition`.
 *
 * REGLA NO NEGOCIABLE (ADR-014 §3): CERO strings mágicos. Ninguna mutación de estado compara strings a
 * mano: se invoca `assertTransition(from, to)` → si la transición no está en la tabla, lanza
 * InvalidStatusTransition (subclase de InvalidStateError de @veo/utils → HTTP 409), nunca un update
 * silencioso ni un `if (estado === 'X')` esparcido.
 *
 * Re-aplicar el MISMO estado (from === to) es SIEMPRE válido: los flujos reales re-aplican estados de
 * forma idempotente (doble-tap del conductor al aprobar, re-consumo de un evento) y eso debe ser un
 * no-op, no un error. Un `from` FUERA del enum (fila legacy de DB) no tiene fila en la tabla → inválido
 * SIEMPRE (fail-closed): InvalidStatusTransition (409), nunca TypeError (500).
 */
import { InvalidStateError } from '@veo/utils';

/** Transición no listada en la tabla del eje. El `axis` identifica QUÉ máquina la rechazó. */
export class InvalidStatusTransition extends InvalidStateError {
  constructor(axis: string, from: string, to: string) {
    super(`Transición de ${axis} inválida: ${from} → ${to}`, { axis, from, to });
  }
}

/** Máquina de estados de un eje: tabla + predicado + guarda. */
export interface StateMachine<S extends string> {
  /** Tabla de transiciones válidas (única fuente de verdad del eje). */
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  /** ¿Es válida `from → to`? (from === to siempre lo es: re-aplicación idempotente). */
  canTransition(from: S, to: S): boolean;
  /** Verifica `from → to`; si no es válida lanza InvalidStatusTransition (409). */
  assertTransition(from: S, to: S): void;
}

/** Crea la máquina de un eje a partir de su tabla de transiciones. */
export function createStateMachine<S extends string>(
  axis: string,
  transitions: Readonly<Record<S, readonly S[]>>,
): StateMachine<S> {
  const canTransition = (from: S, to: S): boolean => {
    // `from` puede venir de la DB como string legacy fuera del enum: sin fila → fail-closed.
    const allowed: readonly S[] | undefined = transitions[from];
    if (!allowed) return false;
    return from === to || allowed.includes(to);
  };
  return {
    transitions,
    canTransition,
    assertTransition(from: S, to: S): void {
      if (!canTransition(from, to)) throw new InvalidStatusTransition(axis, from, to);
    },
  };
}
