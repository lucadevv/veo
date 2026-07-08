/**
 * Ganancia de UN viaje para el resumen de cierre (pantalla TripComplete). Modelo VEO: la plataforma
 * retiene una COMISIÓN sobre la tarifa y el resto es el NETO del conductor.
 *
 * Se calcula desde `fareCents` del viaje (`driverTripView`) porque el cierre ocurre antes de que el
 * agregado de ganancias del período se recomponga; es el mismo modelo bruto − comisión que usa la
 * pantalla de Ganancias, aplicado a un solo viaje. La comisión se redondea a céntimos.
 */
export const VEO_COMMISSION_RATE = 0.12;

export interface TripEarnings {
  /** Tarifa del viaje (céntimos PEN). */
  fareCents: number;
  /** Comisión VEO retenida (céntimos PEN). */
  commissionCents: number;
  /** Neto para el conductor (céntimos PEN) = tarifa − comisión. */
  netCents: number;
  /** Fracción de comisión aplicada (para mostrar "Comisión VEO (12%)"). */
  commissionRate: number;
}

/**
 * Descompone la tarifa de un viaje en comisión + neto. Defensa: una tarifa no finita o negativa
 * (dato fuera de contrato) degrada a 0 — nunca produce NaN ni un neto negativo.
 */
export function computeTripEarnings(
  fareCents: number,
  commissionRate: number = VEO_COMMISSION_RATE,
): TripEarnings {
  const safeFare = Number.isFinite(fareCents) && fareCents > 0 ? Math.round(fareCents) : 0;
  const commissionCents = Math.round(safeFare * commissionRate);
  const netCents = safeFare - commissionCents;
  return { fareCents: safeFare, commissionCents, netCents, commissionRate };
}

/** Comisión en puntos porcentuales enteros (12% → 12) para la etiqueta del desglose. */
export function commissionPercent(commissionRate: number = VEO_COMMISSION_RATE): number {
  return Math.round(commissionRate * 100);
}
