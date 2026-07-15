/**
 * Claves de caché COMPARTIDAS del dominio de viajes. Viven en `domain` (no en `presentation`) para
 * que otras features (chat, realtime) lean/invaliden el MISMO cache SIN importar los hooks internos
 * de `trips/presentation` (feature-isolation). Cada consumidor arma su `useQuery`/invalidación sobre
 * estas claves.
 */

/** Prefijo de caché de viajes (para invalidación masiva desde realtime). */
export const TRIP_QUERY_PREFIX = ['trip'] as const;

/** Clave de caché del detalle de un viaje. */
export const tripQueryKey = (tripId: string) => ['trip', tripId] as const;

/** Clave de caché del viaje ACTIVO del conductor (rehidratación tras reinicio). */
export const ACTIVE_TRIP_QUERY_KEY = ['trip', 'active'] as const;

/** Clave de caché de la tasa de comisión ON-DEMAND vigente (config global, no depende del viaje). */
export const COMMISSION_RATE_QUERY_KEY = ['commission', 'rate'] as const;

/** Clave de caché del cobro en EFECTIVO pendiente de confirmar del conductor (banner del dashboard). */
export const PENDING_CASH_QUERY_KEY = ['trip', 'pending-cash'] as const;
