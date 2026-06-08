import type { MyRatingView } from '@veo/api-client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { TOKENS } from '../../../core/di/tokens';
import { useDependency } from '../../../core/di/useDependency';

/** Clave de cache compartida por la lista del historial y el detalle (una sola verdad por viaje). */
export const myTripRatingKey = (tripId: string): readonly string[] => [
  'rating',
  tripId,
  'mine',
];

export interface UseMyTripRatingOptions {
  /**
   * Solo consultamos cuando tiene sentido: viaje COMPLETADO con conductor calificable. Para viajes
   * cancelados/vivos no hay nada que calificar, así que evitamos la llamada (no es un N+1 ciego: la
   * lista habilita esto solo en sus filas completadas visibles, y el cache es largo).
   */
  enabled?: boolean;
}

/**
 * Mi calificación PARA un viaje (`null` si todavía no califiqué). Cacheada por `tripId` y compartida
 * entre el historial (indicador "Califica" vs "★ N") y el detalle (estado de solo-lectura). El
 * `staleTime` es largo: una calificación enviada es inmutable (el backend no reabre la ventana), así
 * que no tiene sentido re-pedirla en cada foco. Tras calificar, invalidamos esta clave a mano.
 */
export function useMyTripRating(
  tripId: string,
  { enabled = true }: UseMyTripRatingOptions = {},
): UseQueryResult<MyRatingView | null> {
  const ratings = useDependency(TOKENS.ratingsRepository);
  return useQuery({
    queryKey: myTripRatingKey(tripId),
    queryFn: () => ratings.getMyRatingForTrip(tripId),
    enabled,
    staleTime: 1000 * 60 * 30, // 30 min: la calificación no cambia una vez enviada.
    gcTime: 1000 * 60 * 60,
    retry: 1,
  });
}
