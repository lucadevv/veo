/**
 * Fábrica de máquinas de estado de identity (espejo del precedente trip-state-machine de
 * trip-service, generalizado porque identity tiene CUATRO ejes de estado — DriverStatus,
 * BackgroundCheckStatus, KycStatus y AdminStatus — y duplicar la mecánica ×4 sería el mismo
 * copy-paste que este módulo viene a eliminar).
 *
 * Cada eje declara su tabla `Record<Estado, Estado[]>` (única fuente de verdad) y obtiene
 * `canTransition`/`assertTransition`. Cualquier transición no listada lanza
 * InvalidStatusTransition (subclase de InvalidStateError de @veo/utils → HTTP 409), en vez de
 * un update silencioso.
 *
 * Re-aplicar el MISMO estado (from === to) es SIEMPRE válido: los flujos reales re-aplican
 * estados de forma idempotente (re-aprobar un operador para cambiarle roles, re-verificar KYC
 * de un pasajero ya VERIFIED, re-iniciar turno estando AVAILABLE) y eso hoy es un no-op
 * observable que NO debe volverse error.
 *
 * Un `from` FUERA del enum (string crudo de una fila legacy de DB) NO tiene fila en la tabla:
 * es inválido SIEMPRE (incluso from === to) → InvalidStatusTransition (409), nunca TypeError (500).
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
