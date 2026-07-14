/**
 * Ganancia de UN viaje para el resumen de cierre (pantalla TripComplete). Modelo VEO: la plataforma
 * retiene una COMISIÓN sobre la tarifa y el resto es el NETO del conductor.
 *
 * Se calcula desde `fareCents` del viaje (`driverTripView`) porque el cierre ocurre antes de que el
 * agregado de ganancias del período se recomponga; es el mismo modelo bruto − comisión que usa la
 * pantalla de Ganancias, aplicado a un solo viaje. La comisión se redondea a céntimos.
 *
 * LA TASA NO VIVE ACÁ: es configurable desde el panel admin (payment-service `commission_config`,
 * Finanzas → Precios) y el app la trae VIGENTE del driver-bff (`GET /earnings/commission-rate`, en bps).
 */

/** Denominador de basis points: 10000 bps = 100 % (mismo contrato que payment-service). */
export const BPS_DENOMINATOR = 10_000;

/**
 * Tasa de FALLBACK — SOLO para degradación offline (la query de la tasa aún no resolvió / sin red).
 * 0.20 espeja el default del backend (env `COMMISSION_RATE` de payment-service); la fuente de verdad
 * es SIEMPRE el panel admin. JAMÁS tratar este valor como la tasa aplicada.
 */
export const FALLBACK_COMMISSION_RATE = 0.2;

/**
 * bps del servidor (Int 0..10000) → fracción 0..1 que consume `computeTripEarnings`. Defensa: un bps
 * ausente (query sin resolver) o fuera de contrato degrada al fallback offline, nunca NaN ni negativo.
 */
export function commissionRateFromBps(bps: number | undefined): number {
  if (bps === undefined || !Number.isFinite(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    return FALLBACK_COMMISSION_RATE;
  }
  return bps / BPS_DENOMINATOR;
}

export interface TripEarnings {
  /** Tarifa del viaje (céntimos PEN). */
  fareCents: number;
  /** Comisión VEO retenida (céntimos PEN). */
  commissionCents: number;
  /** Neto para el conductor (céntimos PEN) = tarifa − comisión. */
  netCents: number;
  /** Fracción de comisión aplicada (para mostrar "Comisión VEO (20%)"). */
  commissionRate: number;
}

/**
 * Descompone la tarifa de un viaje en comisión + neto. Defensa: una tarifa no finita o negativa
 * (dato fuera de contrato) degrada a 0 — nunca produce NaN ni un neto negativo.
 */
export function computeTripEarnings(
  fareCents: number,
  commissionRate: number = FALLBACK_COMMISSION_RATE,
): TripEarnings {
  const safeFare = Number.isFinite(fareCents) && fareCents > 0 ? Math.round(fareCents) : 0;
  const commissionCents = Math.round(safeFare * commissionRate);
  const netCents = safeFare - commissionCents;
  return { fareCents: safeFare, commissionCents, netCents, commissionRate };
}

/** Comisión en puntos porcentuales enteros (0.2 → 20) para la etiqueta del desglose. */
export function commissionPercent(commissionRate: number = FALLBACK_COMMISSION_RATE): number {
  return Math.round(commissionRate * 100);
}
