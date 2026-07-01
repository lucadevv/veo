import type { MapPoint } from '@veo/api-client';
import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { ReverseGeocodeUseCase } from '../../domain';
import { MAPS_QUERY_KEY } from './useAutocomplete';

/**
 * Geocoding inverso de un punto: etiqueta legible (título + subtítulo) para nombrar una ubicación
 * (p. ej. "Tu ubicación"). Deshabilitado hasta tener `point`. Espeja el caso de uso del pasajero.
 */
export function useReverseGeocode(point: MapPoint | null | undefined) {
  const { maps } = useRepositories();
  return useQuery({
    queryKey: [...MAPS_QUERY_KEY, 'reverse', point?.lat ?? null, point?.lng ?? null],
    queryFn: () => new ReverseGeocodeUseCase(maps).execute(point as MapPoint),
    enabled: !!point,
    staleTime: 30_000,
  });
}
