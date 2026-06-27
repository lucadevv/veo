/**
 * F2.5 (ADR-017 §1.4) — FUENTE ÚNICA del costo de energía POR KM, para el ON-DEMAND de trip-service
 * (`deriveFuelPerKmCents` delega acá: precio÷rendimiento del EnergyCatalog vivo).
 *
 *   costo/km (céntimos) = precio_por_unidad (céntimos) ÷ rendimiento (km por unidad)
 *
 * Es la fórmula estándar de costo de energía por km: vale para líquido (S/litro ÷ km/L) y eléctrico
 * (S/kWh ÷ km/kWh) — solo cambia la `EnergyUnit`. DEGRADACIÓN HONESTA con los MISMOS guards que el
 * `deriveFuelPerKmCents` original (que ahora delega acá): precio < 0 / no-finito → 0; rendimiento ≤ 0 /
 * no-finito → 0 (sin recargo, NUNCA división por cero ni NaN propagado al precio). Redondeo a céntimo
 * ENTERO (Math.round) — el costo de energía es un INSUMO de la tarifa on-demand, no un máximo legal.
 *
 * NOTA (F2.5 · carpooling): el costo-cap del carpooling YA NO deriva de energía. Su costo/km es el costo de
 * OPERACIÓN real (combustible + desgaste) que el ADMIN fija por país (booking-service `CostPerKmConfig`); por
 * eso la antigua `CARPOOLING_COST_REFERENCE` (derivada de la oferta VEO_ECONÓMICO) se removió de acá.
 */

/**
 * Costo de energía por km (céntimos Int) = precio_por_unidad ÷ rendimiento. Guards idénticos al
 * `deriveFuelPerKmCents` histórico de trip-service (que delega en esta): entradas degeneradas → 0.
 */
export function deriveCostPerKmCents(energyPriceCents: number, efficiencyKmPerUnit: number): number {
  if (!Number.isFinite(energyPriceCents) || energyPriceCents < 0) return 0;
  if (!Number.isFinite(efficiencyKmPerUnit) || efficiencyKmPerUnit <= 0) return 0;
  return Math.round(energyPriceCents / efficiencyKmPerUnit);
}
