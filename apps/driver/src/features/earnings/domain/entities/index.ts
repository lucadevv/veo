import type {
  DriverEarningsBreakdown,
  DriverEarningsDailySeries,
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

/** Respuesta de `GET /earnings/breakdown`: desglose de HOY, SEMANA y MES + moneda. */
export type EarningsBreakdown = DriverEarningsSummary;

/**
 * Serie diaria de la SEMANA en curso (lunes→domingo, 7 puntos): neto y nº de viajes por día. Alimenta
 * el bar chart "Por día". Es el dato de `GET /earnings/daily`. Días sin viajes vienen en cero.
 */
export type EarningsDailySeries = DriverEarningsDailySeries;
