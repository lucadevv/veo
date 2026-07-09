/**
 * Claves de caché COMPARTIDAS del dominio de turno. Viven en `domain` (no en `presentation`) para que
 * otras features (bidding, realtime, viajes) lean/invaliden el MISMO estado de turno con cache
 * coherente SIN importar los hooks internos de `shift/presentation` (feature-isolation).
 */

/** Clave de caché del estado de turno. */
export const SHIFT_STATE_QUERY_KEY = ['shift', 'state'] as const;
