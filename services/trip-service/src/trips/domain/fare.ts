/**
 * BR-T05 — Cálculo de tarifa (lógica de dominio pura, sin I/O).
 *
 *   tarifa = (BASE + POR_KM·km + POR_MIN·min) · surge   [+ FEE_NIÑO si childMode]
 *
 * Todo en céntimos PEN usando los helpers de @veo/utils. km y min se derivan de la ruta
 * que entrega @veo/maps (distanceMeters, durationSeconds). surge ∈ [1.0, 2.0] (default 1.0).
 */
import { money, scaleMoney, addMoney, type Money, ValidationError } from '@veo/utils';

/** Banderazo base: S/ 6.00. */
export const BASE_FARE_CENTS = 600;
/** Por kilómetro: S/ 1.20. */
export const PER_KM_CENTS = 120;
/** Por minuto: S/ 0.30. */
export const PER_MIN_CENTS = 30;
/** Recargo por modo niño (BR-T07): S/ 2.00. */
export const CHILD_MODE_FEE_CENTS = 200;

export const MIN_SURGE = 1.0;
export const MAX_SURGE = 2.0;

export interface FareInput {
  distanceMeters: number;
  durationSeconds: number;
  /** Multiplicador de demanda calculado por dispatch (1.0–2.0). Default 1.0. */
  surgeMultiplier?: number;
  childMode?: boolean;
}

/**
 * Calcula la tarifa total en céntimos PEN. Lanza ValidationError si los insumos son inválidos
 * (distancia/duración negativas o surge fuera de rango).
 */
export function calculateFare(input: FareInput): Money {
  const { distanceMeters, durationSeconds } = input;
  const surge = input.surgeMultiplier ?? 1.0;
  const childMode = input.childMode ?? false;

  if (distanceMeters < 0 || !Number.isFinite(distanceMeters)) {
    throw new ValidationError('distanceMeters inválida', { distanceMeters });
  }
  if (durationSeconds < 0 || !Number.isFinite(durationSeconds)) {
    throw new ValidationError('durationSeconds inválida', { durationSeconds });
  }
  if (surge < MIN_SURGE || surge > MAX_SURGE) {
    throw new ValidationError('surgeMultiplier fuera de rango [1.0, 2.0]', { surge });
  }

  const km = distanceMeters / 1000;
  const min = durationSeconds / 60;

  const subtotalCents = Math.round(BASE_FARE_CENTS + PER_KM_CENTS * km + PER_MIN_CENTS * min);
  const surged = scaleMoney(money(subtotalCents), surge);
  return childMode ? addMoney(surged, money(CHILD_MODE_FEE_CENTS)) : surged;
}
