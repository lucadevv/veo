import type { CommissionView, ReplaceCommissionRequest } from '@/lib/api/schemas';

/**
 * Helpers PUROS de la comisión por modo, compartidos por los DOS paneles que la separan por carril:
 * `OnDemandCommissionPanel` (Precios on-demand · solo `onDemandRateBps`) y `CarpoolingFeePanel`
 * (Carpooling · solo `carpoolingFeeBps`). Ambas tasas viven en UN config con UNA versión (CAS), pero las
 * edita gente distinta en pantallas distintas — por eso cada save tiene que PRESERVAR la tasa del otro carril.
 * Hermano de `bidFloorDefaultReplace` (`@/lib/bid-floor`): la misma semántica preservadora sobre un full-replace.
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

/** El parche de UN solo carril. Cada panel edita EXACTAMENTE una tasa; la otra se preserva tal cual. */
export type CommissionPatch = { onDemandRateBps: number } | { carpoolingFeeBps: number };

/**
 * Body del `PUT /finance/commission` cuando SOLO cambia UNA tasa (un panel por carril). El PUT es full-replace
 * con AMBAS tasas, así que hay que REMANDAR la del otro carril TAL CUAL está persistida: perderla sería borrar
 * dinero (un panel de un carril no debe poder pisar la comisión del otro). `expectedVersion` = el CAS del config
 * cargado (si otro admin lo movió → 409). Espejo de `bidFloorDefaultReplace`.
 */
export function commissionReplace(
  config: Pick<CommissionView, 'onDemandRateBps' | 'carpoolingFeeBps' | 'version'>,
  patch: CommissionPatch,
): ReplaceCommissionRequest {
  return {
    onDemandRateBps: config.onDemandRateBps,
    carpoolingFeeBps: config.carpoolingFeeBps,
    ...patch,
    expectedVersion: config.version,
  };
}
