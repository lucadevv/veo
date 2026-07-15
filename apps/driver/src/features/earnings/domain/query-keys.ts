/**
 * Claves de caché COMPARTIDAS del dominio de ganancias. Viven en `domain` (no en `presentation`) para
 * que otras features (turno) lean el MISMO cache con coherencia SIN importar los hooks internos de
 * `earnings/presentation` (feature-isolation).
 */

/** Clave de caché del resumen de ganancias. */
export const EARNINGS_SUMMARY_QUERY_KEY = ['earnings', 'summary'] as const;

/** Clave de caché del desglose de ganancias (HOY/SEMANA/MES). */
export const EARNINGS_BREAKDOWN_QUERY_KEY = ['earnings', 'breakdown'] as const;

/** Clave de caché de la serie diaria (bar chart "Por día"). */
export const EARNINGS_DAILY_QUERY_KEY = ['earnings', 'daily'] as const;
