import type {
  DriverEarningsBreakdown,
  DriverEarningsSummary,
  DriverPayoutView,
  EarningsSummary,
} from '@veo/api-client';

/**
 * Entidades del dominio de ganancias. Montos siempre en céntimos PEN (enteros), agregados a partir
 * de los payouts reales del conductor autenticado.
 */
export type EarningsOverview = EarningsSummary;
export type Payout = DriverPayoutView;

/**
 * Desglose de ganancias de un período (HOY o SEMANA): bruto, comisión, propinas, NETO y nº de
 * viajes. Todos los montos en céntimos PEN. Es el dato base de `GET /earnings/breakdown`.
 */
export type EarningsPeriodBreakdown = DriverEarningsBreakdown;

/** Respuesta de `GET /earnings/breakdown`: desglose de HOY y de la SEMANA + moneda. */
export type EarningsBreakdown = DriverEarningsSummary;
