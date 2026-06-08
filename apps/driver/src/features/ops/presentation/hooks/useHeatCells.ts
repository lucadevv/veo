import {useMemo} from 'react';
import type {HeatCell} from '../../../../shared/presentation/components/AppMap';
import {
  intensityToOpacity,
  intensityToRadiusMeters,
  type DemandHeatmap,
} from '../../domain';

/**
 * Lógica pura: convierte las celdas crudas del mapa de calor a `HeatCell[]` con el estilo
 * (opacidad/radio) ya derivado de la intensidad por la lógica de dominio.
 *
 * Defensa robusta ante datos reales/inesperados: `heatmap` puede llegar `undefined` (React Query antes
 * de cargar), sin `cells`, con `cells` no-array, o con celdas cuyo centroide es NaN/incompleto. Sin
 * estas guardas, `heatmap.cells.map` reventaría el render del dashboard. Devuelve `[]` en cualquier
 * forma degradada y descarta celdas con coordenadas inválidas.
 */
export function toHeatCells(heatmap: DemandHeatmap | null | undefined): HeatCell[] {
  if (!heatmap || !Array.isArray(heatmap.cells)) {
    return [];
  }
  return heatmap.cells
    .filter(
      (cell): cell is (typeof heatmap.cells)[number] =>
        cell != null &&
        Number.isFinite(cell.centroidLng) &&
        Number.isFinite(cell.centroidLat),
    )
    .map(cell => ({
      id: cell.h3,
      coordinate: [cell.centroidLng, cell.centroidLat],
      opacity: intensityToOpacity(cell.intensity),
      radiusMeters: intensityToRadiusMeters(cell.intensity),
    }));
}

/**
 * Hook que memoiza `toHeatCells` para evitar recalcular en cada frame y dejar la pantalla declarativa.
 */
export function useHeatCells(heatmap: DemandHeatmap | undefined): HeatCell[] {
  return useMemo(() => toHeatCells(heatmap), [heatmap]);
}
