import type { OpsRepository } from '../repositories/ops-repository';
import type { DemandHeatmap, HeatmapQuery, IncentiveList } from '../entities';
import { incentiveSortRank } from '../value-objects/incentive-progress';

/** Caso de uso: mapa de calor de demanda alrededor del conductor. */
export class GetHeatmapUseCase {
  constructor(private readonly ops: OpsRepository) {}
  execute(query: HeatmapQuery): Promise<DemandHeatmap> {
    return this.ops.getHeatmap(query);
  }
}

/**
 * Caso de uso: incentivos activos del conductor, ordenados para la pantalla (activos primero,
 * luego completados, vencidos al final). Ordenar en el dominio mantiene la UI declarativa y testable.
 */
export class ListIncentivesUseCase {
  constructor(private readonly ops: OpsRepository) {}
  async execute(now: Date = new Date()): Promise<IncentiveList> {
    const incentives = await this.ops.listIncentives();
    return [...incentives].sort((a, b) => incentiveSortRank(a, now) - incentiveSortRank(b, now));
  }
}
