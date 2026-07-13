import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { MAPS_QUERY_KEY } from '../../../maps/domain';

/**
 * Etiqueta a nivel DISTRITO de un punto (reverse-geocode vía driver-bff `/maps/reverse`). Para las cards
 * de puja: el origen/destino vienen OFUSCADOS a ~111m (privacidad pre-aceptación, Ley 29733) → el label
 * natural es el distrito ("Miraflores"), no la calle exacta. Cacheada por coords con `staleTime` largo (el
 * distrito no cambia) → el MISMO punto no re-geocodea en cada refetch de la lista de pujas (poll 12s + pings).
 */
export function useReverseLabel(lat: number, lon: number): string | null {
  const { maps } = useRepositories();
  const query = useQuery({
    queryKey: [...MAPS_QUERY_KEY, 'reverse', lat, lon],
    queryFn: () => maps.reverse({ lat, lng: lon }),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
  return query.data?.title ?? null;
}
