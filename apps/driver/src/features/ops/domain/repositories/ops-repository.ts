import type { DemandHeatmap, HeatmapQuery, IncentiveList } from '../entities';

/**
 * Contrato del repositorio operativo (mapa de calor + incentivos). Implementación concreta en
 * `data/`. Ambos endpoints son del driver-bff con JWT del conductor.
 */
export interface OpsRepository {
  /** GET /heatmap?lat&lng&radius — celdas de demanda reciente cerca del conductor. */
  getHeatmap(query: HeatmapQuery): Promise<DemandHeatmap>;
  /** GET /incentives — incentivos activos del conductor con su progreso. */
  listIncentives(): Promise<IncentiveList>;
}
