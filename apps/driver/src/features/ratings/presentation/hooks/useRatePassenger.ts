import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  GetMyTripRatingUseCase,
  RatePassengerUseCase,
  tripRatingQueryKey,
  type RatePassengerInput,
} from '../../domain';

// `tripRatingQueryKey` vive ahora en `ratings/domain` (cache compartido con el cierre de viaje).
// Se re-exporta para no romper a los consumidores del barrel.
export { tripRatingQueryKey };

/**
 * Query: MI calificación de un viaje (la que ESTE conductor le dio al pasajero). `null` si aún no
 * califiqué. Inactiva con `tripId` vacío. La usa el cierre del viaje para no re-pedir calificar.
 */
export function useMyTripRating(tripId: string) {
  const { ratings } = useRepositories();
  return useQuery({
    queryKey: tripRatingQueryKey(tripId),
    queryFn: () => new GetMyTripRatingUseCase(ratings).execute(tripId),
    enabled: tripId.length > 0,
  });
}

/**
 * Mutación: el conductor califica al pasajero al cerrar el viaje. Al lograrlo, siembra la caché de MI
 * rating con el resultado del servidor (el cierre pasa a estado "ya calificaste" sin un GET extra).
 */
export function useRatePassenger(tripId: string) {
  const { ratings } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RatePassengerInput) => new RatePassengerUseCase(ratings).execute(input),
    onSuccess: (rating) => {
      queryClient.setQueryData(tripRatingQueryKey(tripId), {
        stars: rating.stars,
        comment: rating.comment,
        createdAt: rating.createdAt,
      });
    },
  });
}
