/**
 * Claves de caché (React Query) del dominio de Pagos. Viven en `domain` para que cualquier feature que
 * lea estos datos (el gate de deuda del viaje, "Invita y gana" en referidos) comparta la MISMA clave sin
 * importar la `presentation` de Payments: caché coherente e invalidaciones que casan por prefijo.
 */

/** Clave de caché de las deudas del pasajero (`GET /payments/debts`). Compartida home + sheet de deuda. */
export const MY_DEBTS_QUERY_KEY = ['payments', 'debts'] as const;

/** Clave de caché del saldo de crédito gastable del pasajero (`GET /payments/credit`). */
export const USER_CREDIT_QUERY_KEY = ['payments', 'credit'] as const;

/** Clave de caché compartida del estado de afiliación Yape (perfil + señal en el quoting). */
export const YAPE_AFFILIATION_QUERY_KEY = ['affiliation', 'yape'] as const;
