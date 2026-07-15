import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  ACTIVE_TRIP_QUERY_KEY,
  GetActiveTripUseCase,
  GetTripUseCase,
  tripQueryKey,
} from '../../../trips/domain';

/**
 * Queries FINAS de viaje que realtime necesita para rehidratar/seguir el viaje activo. Envuelven los
 * casos de uso públicos de `trips/domain` sobre las claves COMPARTIDAS (`tripQueryKey`,
 * `ACTIVE_TRIP_QUERY_KEY`): MISMO cache que `trips/presentation` (coherente), SIN importar sus hooks
 * internos (feature-isolation).
 */

/** Query: detalle de un viaje (lado conductor). Inactiva con `tripId` vacío. */
export function useTrip(tripId: string) {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: tripQueryKey(tripId),
    queryFn: () => new GetTripUseCase(trips).execute(tripId),
    enabled: tripId.length > 0,
  });
}

/** Query: viaje ACTIVO del conductor para REHIDRATAR tras un reinicio (`null` si no hay en curso). */
export function useActiveTrip() {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: ACTIVE_TRIP_QUERY_KEY,
    queryFn: () => new GetActiveTripUseCase(trips).execute(),
  });
}
