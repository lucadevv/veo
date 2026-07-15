import type { EarningsBreakdown, EarningsDailySeries, EarningsOverview } from '../entities';

/**
 * Contrato del repositorio de ganancias (capa domain). Implementación concreta en `data/`.
 */
export interface EarningsRepository {
  /** GET /earnings/summary — resumen agregado de ganancias del conductor. */
  getSummary(): Promise<EarningsOverview>;
  /** GET /earnings/breakdown — desglose de HOY, SEMANA y MES (bruto/comisión/propinas/neto/viajes). */
  getBreakdown(): Promise<EarningsBreakdown>;
  /** GET /earnings/daily — serie diaria de la SEMANA en curso (7 puntos, lun→dom) para el bar chart. */
  getDaily(): Promise<EarningsDailySeries>;
}
