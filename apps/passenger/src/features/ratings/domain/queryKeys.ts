/**
 * Claves de caché (React Query) del dominio de Calificaciones. Viven en `domain` para que cualquier
 * feature que muestre calificaciones (el detalle de un viaje, la cabecera del Perfil) comparta la
 * MISMA clave sin importar la `presentation` de Ratings: una sola verdad por viaje/sujeto → caché
 * coherente e invalidaciones que casan por prefijo desde cualquier consumidor.
 */

/** Clave de cache compartida por la lista del historial y el detalle (una sola verdad por viaje). */
export const myTripRatingKey = (tripId: string): readonly string[] => [
  'rating',
  tripId,
  'mine',
];

/** Clave de cache del agregado rolling 30d de un sujeto (pasajero o conductor). */
export const myAggregateRatingKey = (subjectId: string): readonly string[] => [
  'rating',
  'aggregate',
  subjectId,
];
