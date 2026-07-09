import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import type { HeatCell } from '../../../../shared/presentation/components/AppMap';
import {
  GetHeatmapUseCase,
  heatmapQueryKey,
  intensityToOpacity,
  intensityToRadiusMeters,
  type DemandHeatmap,
  type HeatmapQuery,
} from '../../../ops/domain';

/**
 * Hooks FINOS de demanda que consume el DASHBOARD de turno (mapa de calor). Envuelven el caso de uso
 * público `GetHeatmapUseCase` y la lógica de intensidad de `ops/domain` sobre la clave COMPARTIDA
 * `heatmapQueryKey`: MISMO cache que `ops/presentation` (coherente), SIN importar sus hooks internos
 * (feature-isolation).
 */

/**
 * Query: mapa de calor de demanda. Solo se dispara con una consulta válida (`query === null` la deja
 * inactiva). Refresca cada 60 s mientras está activa; fresca 30 s.
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

/**
 * Lógica pura: convierte las celdas crudas del mapa de calor a `HeatCell[]` con el estilo
 * (opacidad/radio) ya derivado de la intensidad por la lógica de dominio. Defensa robusta ante datos
 * inesperados: devuelve `[]` en cualquier forma degradada y descarta celdas con coordenadas inválidas.
 */
export function toHeatCells(heatmap: DemandHeatmap | null | undefined): HeatCell[] {
  if (!heatmap || !Array.isArray(heatmap.cells)) {
    return [];
  }
  return heatmap.cells
    .filter(
      (cell): cell is (typeof heatmap.cells)[number] =>
        cell != null && Number.isFinite(cell.centroidLng) && Number.isFinite(cell.centroidLat),
    )
    .map((cell) => ({
      id: cell.h3,
      coordinate: [cell.centroidLng, cell.centroidLat],
      opacity: intensityToOpacity(cell.intensity),
      radiusMeters: intensityToRadiusMeters(cell.intensity),
    }));
}

/** Hook que memoiza `toHeatCells` para no recalcular en cada frame. */
export function useHeatCells(heatmap: DemandHeatmap | undefined): HeatCell[] {
  return useMemo(() => toHeatCells(heatmap), [heatmap]);
}
