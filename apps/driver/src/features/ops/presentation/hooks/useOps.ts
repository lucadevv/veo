import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { GetHeatmapUseCase, ListIncentivesUseCase, type HeatmapQuery } from '../../domain';

/** Clave de caché del mapa de calor (depende de lat/lng redondeados + radio). */
export const heatmapQueryKey = (query: HeatmapQuery | null) =>
  query
    ? ([
        'ops',
        'heatmap',
        query.lat.toFixed(3),
        query.lng.toFixed(3),
        query.radius ?? 'default',
      ] as const)
    : (['ops', 'heatmap', 'idle'] as const);

/** Clave de caché de incentivos. */
export const INCENTIVES_QUERY_KEY = ['ops', 'incentives'] as const;

/**
 * Query: mapa de calor de demanda. Solo se dispara cuando hay una consulta válida (toggle activo +
 * ubicación conocida): `query === null` deja la query inactiva. Refresca cada 60 s mientras está
 * activa para reflejar la demanda reciente, y se considera fresca 30 s.
 */
export function useHeatmap(query: HeatmapQuery | null) {
  const { ops } = useRepositories();
  return useQuery({
    queryKey: heatmapQueryKey(query),
    queryFn: () => new GetHeatmapUseCase(ops).execute(query as HeatmapQuery),
    enabled: query !== null,
    staleTime: 30_000,
    refetchInterval: query !== null ? 60_000 : false,
  });
}

/** Query: incentivos activos del conductor (ya ordenados por estado en el caso de uso). */
export function useIncentives() {
  const { ops } = useRepositories();
  return useQuery({
    queryKey: INCENTIVES_QUERY_KEY,
    queryFn: () => new ListIncentivesUseCase(ops).execute(),
  });
}
