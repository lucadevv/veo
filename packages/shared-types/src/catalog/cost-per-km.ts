/**
 * F2.5 (ADR-017 §1.4) — FUENTE ÚNICA del costo de energía POR KM. Antes vivían DOS derivadores
 * desconectados: el on-demand (trip-service `deriveFuelPerKmCents`) derivaba precio÷rendimiento del
 * EnergyCatalog vivo; el carpooling (booking-service) usaba un costo/km FLAT de env. Esta función
 * unifica la FÓRMULA: ambos caminos la consumen, así el número nunca diverge.
 *
 *   costo/km (céntimos) = precio_por_unidad (céntimos) ÷ rendimiento (km por unidad)
 *
 * Es la fórmula estándar de costo de energía por km: vale para líquido (S/litro ÷ km/L) y eléctrico
 * (S/kWh ÷ km/kWh) — solo cambia la `EnergyUnit`. DEGRADACIÓN HONESTA con los MISMOS guards que el
 * `deriveFuelPerKmCents` original (que ahora delega acá): precio < 0 / no-finito → 0; rendimiento ≤ 0 /
 * no-finito → 0 (sin recargo, NUNCA división por cero ni NaN propagado al precio). Redondeo a céntimo
 * ENTERO (Math.round) — el costo de energía es un INSUMO de la tarifa/tope, no el máximo legal en sí
 * (ese lo trunca con floor quien construye el tope, ver booking `cost-cap.ts`).
 */
import type { EnergySource } from '../enums/index.js';
import { OFFERINGS, OfferingId } from './offerings.js';

/**
 * Costo de energía por km (céntimos Int) = precio_por_unidad ÷ rendimiento. Guards idénticos al
 * `deriveFuelPerKmCents` histórico de trip-service (que delega en esta): entradas degeneradas → 0.
 */
export function deriveCostPerKmCents(energyPriceCents: number, efficiencyKmPerUnit: number): number {
  if (!Number.isFinite(energyPriceCents) || energyPriceCents < 0) return 0;
  if (!Number.isFinite(efficiencyKmPerUnit) || efficiencyKmPerUnit <= 0) return 0;
  return Math.round(energyPriceCents / efficiencyKmPerUnit);
}

/** Vehículo de REFERENCIA del costo/km: la fuente de energía + su rendimiento (km por unidad). */
export interface CostReference {
  energySource: EnergySource;
  efficiencyKmPerUnit: number;
}

/**
 * F2.5 · REFERENCIA del costo-cap del carpooling = la oferta VEO_ECONÓMICO (auto eficiente, GASOLINE_90,
 * 12 km/L). Se DERIVA de `OFFERINGS[VEO_ECONOMICO]` (su `referenceEnergySourceId` + `referenceEfficiency`)
 * para que NUNCA diverja del catálogo: si mañana se afina el rendimiento del económico, el tope legal lo
 * sigue solo.
 *
 * POR QUÉ EL ECONÓMICO (no el vehículo real del conductor): es el CONSERVADOR LEGAL. Un auto eficiente
 * (12 km/L) da el costo/km MÁS BAJO → el tope de cost-sharing MÁS BAJO → el conductor NUNCA puede lucrar,
 * sea cual sea su vehículo real (un XL gasta más, así que su costo real ≥ este → el tope acota por lo bajo).
 * Per-vehículo (rendimiento real del auto que publica) sería un refinamiento FUTURO; hoy la referencia
 * económica es el piso seguro anti-lucro (ADR-014 §8 · ADR-017 §1.4).
 */
export const CARPOOLING_COST_REFERENCE: CostReference = {
  energySource: OFFERINGS[OfferingId.VEO_ECONOMICO].referenceEnergySourceId,
  efficiencyKmPerUnit: OFFERINGS[OfferingId.VEO_ECONOMICO].referenceEfficiency,
};
