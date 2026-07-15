import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { GetTripUseCase, tripQueryKey } from '../../../trips/domain';

/**
 * Query FINA del detalle del viaje para el chat (nombre/estado del pasajero en el header). Envuelve el
 * caso de uso público `GetTripUseCase` (trips/domain) sobre la clave COMPARTIDA `tripQueryKey`: MISMO
 * cache que `trips/presentation` (coherente), SIN importar sus hooks internos (feature-isolation).
 */
export function useTrip(tripId: string) {
  const { trips } = useRepositories();
  return useQuery({
    queryKey: tripQueryKey(tripId),
    queryFn: () => new GetTripUseCase(trips).execute(tripId),
    enabled: tripId.length > 0,
  });
}
