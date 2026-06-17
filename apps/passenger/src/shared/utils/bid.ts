/**
 * Lógica pura del stepper de PUJA ("proponé tu precio", ADR 010). El pasajero ofrece su tarifa con un
 * stepper de a S/1; el PISO de zona (`bidFloorCents`, del quote) es inviolable del lado UI (el servidor
 * lo re-valida autoritativo). Sin estado ni React: testeable de forma aislada.
 */

/** Paso del stepper: S/ 1.00 (100 céntimos). El diseño sube/baja de a un sol entero. */
export const BID_STEP_CENTS = 100;

/** Redondea céntimos al sol entero más cercano (los bids se muestran y ajustan en soles enteros). */
export function roundToSolCents(cents: number): number {
  return Math.round(cents / 100) * 100;
}

/**
 * Bid inicial del stepper: el sugerido (redondeado a sol entero), nunca por debajo del piso de zona.
 * Sin sugerido (quote sin datos puja) → arranca en el piso. Garantiza `>= floorCents` siempre.
 */
export function initialBidCents(
  suggestedCents: number | undefined,
  floorCents: number,
): number {
  const base =
    suggestedCents !== undefined ? roundToSolCents(suggestedCents) : floorCents;
  return Math.max(floorCents, base);
}

/** Ajusta el bid por `deltaSteps` pasos de S/1, clampeado al piso (nunca baja de la tarifa mínima). */
export function stepBidCents(
  currentCents: number,
  deltaSteps: number,
  floorCents: number,
): number {
  return Math.max(floorCents, currentCents + deltaSteps * BID_STEP_CENTS);
}

/** ¿El bid está en el piso? (para deshabilitar el "−" y mostrar el aviso de tarifa mínima). */
export function isAtFloor(currentCents: number, floorCents: number): boolean {
  return currentCents <= floorCents;
}
