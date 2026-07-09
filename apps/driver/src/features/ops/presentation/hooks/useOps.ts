import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  GetHeatmapUseCase,
  INCENTIVES_QUERY_KEY,
  ListIncentivesUseCase,
  heatmapQueryKey,
  type HeatmapQuery,
} from '../../domain';

// `heatmapQueryKey` e `INCENTIVES_QUERY_KEY` viven ahora en `ops/domain` (cache compartido con el
// dashboard de turno). Se re-exportan para no romper a los consumidores del barrel.
export { INCENTIVES_QUERY_KEY, heatmapQueryKey };

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
