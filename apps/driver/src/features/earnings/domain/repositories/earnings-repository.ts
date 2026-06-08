import type {EarningsBreakdown, EarningsOverview, PayoutList} from '../entities';

/**
 * Contrato del repositorio de ganancias (capa domain). Implementación concreta en `data/`.
 */
export interface EarningsRepository {
  /** GET /earnings/summary — resumen agregado de ganancias del conductor. */
  getSummary(): Promise<EarningsOverview>;
  /** GET /payouts — lista de liquidaciones (payouts) del conductor. */
  listPayouts(): Promise<PayoutList>;
  /** GET /earnings/breakdown — desglose de HOY y SEMANA (bruto/comisión/propinas/neto/viajes). */
  getBreakdown(): Promise<EarningsBreakdown>;
}
