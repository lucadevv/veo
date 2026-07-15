/**
 * Claves de caché COMPARTIDAS del dominio de calificaciones. Viven en `domain` (no en `presentation`)
 * para que otras features (viajes) lean/siembren el MISMO cache SIN importar los hooks internos de
 * `ratings/presentation` (feature-isolation).
 */

/** Clave de caché de MI calificación de un viaje (indicador "ya calificaste" / re-entrada). */
export const tripRatingQueryKey = (tripId: string) => ['rating', tripId] as const;
