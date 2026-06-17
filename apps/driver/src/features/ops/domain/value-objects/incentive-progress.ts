import type { Incentive, IncentiveType } from '../entities';

/**
 * Lógica pura de incentivos: progreso normalizado, formato de recompensa/multiplicador y vigencia.
 * En el dominio para probarse sin UI y mantener la pantalla declarativa.
 */

/**
 * Fracción de progreso 0..1 de un incentivo de META_VIAJES (`progressTrips / targetTrips`).
 * Acotada a [0,1]. Si no hay meta (`targetTrips <= 0`, p. ej. HORA_PICO) → 0: esos incentivos no
 * muestran barra de viajes.
 */
export function incentiveProgressFraction(incentive: Incentive): number {
  if (incentive.targetTrips <= 0) {
    return 0;
  }
  const fraction = incentive.progressTrips / incentive.targetTrips;
  return Math.min(1, Math.max(0, fraction));
}

/** Porcentaje entero 0..100 del progreso (para etiquetas y accesibilidad). */
export function incentiveProgressPercent(incentive: Incentive): number {
  return Math.round(incentiveProgressFraction(incentive) * 100);
}

/** Viajes que faltan para cumplir la meta (nunca negativo). 0 si ya se cumplió o no hay meta. */
export function incentiveTripsRemaining(incentive: Incentive): number {
  if (incentive.targetTrips <= 0) {
    return 0;
  }
  return Math.max(0, incentive.targetTrips - incentive.progressTrips);
}

/**
 * Convierte el multiplicador en puntos básicos (bps, %·100) a un texto de bonificación porcentual
 * por encima de 1.0. Ej.: 12000 bps = 120% del normal = "+20%". 10000 bps = "+0%". Vacío si 0.
 */
export function formatMultiplier(multiplierBps: number): string {
  if (multiplierBps <= 0) {
    return '';
  }
  const extraPercent = Math.round(multiplierBps / 100) - 100;
  const sign = extraPercent >= 0 ? '+' : '';
  return `${sign}${extraPercent}%`;
}

/** `true` si el incentivo ya venció respecto a `now`. */
export function isIncentiveExpired(incentive: Incentive, now: Date = new Date()): boolean {
  const expiry = new Date(incentive.expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return false;
  }
  return expiry.getTime() < now.getTime();
}

/**
 * Estado visual derivado de un incentivo, para elegir tono/etiqueta sin ramificar en la UI:
 *  - 'completed' → ya cumplido (meta lograda o franja activa)
 *  - 'expired' → venció sin completarse
 *  - 'active' → en curso
 */
export type IncentiveState = 'completed' | 'expired' | 'active';

export function incentiveState(incentive: Incentive, now: Date = new Date()): IncentiveState {
  if (incentive.completed) {
    return 'completed';
  }
  if (isIncentiveExpired(incentive, now)) {
    return 'expired';
  }
  return 'active';
}

/** Orden para listar: activos primero, luego completados, vencidos al final. */
export function incentiveSortRank(incentive: Incentive, now: Date = new Date()): number {
  switch (incentiveState(incentive, now)) {
    case 'active':
      return 0;
    case 'completed':
      return 1;
    case 'expired':
      return 2;
  }
}

/** Indica si el tipo usa multiplicador (HORA_PICO) en lugar de bono fijo (META_VIAJES). */
export function isMultiplierIncentive(type: IncentiveType): boolean {
  return type === 'HORA_PICO';
}
