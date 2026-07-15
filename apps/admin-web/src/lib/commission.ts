/**
 * Helpers PUROS de la comisión por modo, compartidos por los DOS paneles que la separan por carril:
 * `OnDemandCommissionPanel` (Precios on-demand · solo `onDemandRateBps`, CAS sobre `version`) y `CarpoolingFeePanel`
 * (Carpooling · solo `carpoolingFeeBps`, CAS sobre `carpoolingFeeVersion` INDEPENDIENTE). Tras el desacople de CAS
 * (#3) cada carril tiene su propia version y su propio endpoint, así que el body de cada PUT lleva SOLO su tasa +
 * su `expectedVersion` (lo arma el panel inline): ya no hace falta preservar la tasa del otro carril (no se pisan).
 */

/** Tope de cordura (espejo del DTO server-side, defensa en profundidad UI). La comisión no pasa de 100%. */
export const MAX_RATE_PCT = 100;
/** 100% = 10000 basis points. La tasa se PERSISTE en bps Int (nunca float); el panel la muestra en %. */
export const BPS_PER_PERCENT = 100;

/** Convierte un input en % a basis points Int (tasa SIEMPRE Int, nunca float persistido). Vacío = 0. */
export function percentToBps(pct: string): number {
  return pct.trim() === '' ? 0 : Math.round(Number(pct) * BPS_PER_PERCENT);
}

/** bps Int → % para mostrar (2000 bps → "20.00"). */
export function bpsToPercentLabel(bps: number): string {
  return (bps / BPS_PER_PERCENT).toFixed(2);
}
