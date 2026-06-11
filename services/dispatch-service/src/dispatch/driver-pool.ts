/**
 * DriverPool — selección de candidatos ELEGIBLES para un viaje (BR-T06). ÚNICA fuente de verdad del
 * pipeline de filtrado: candidatos del hot-index → del tipo de vehículo requerido → NO excluidos por
 * pánico → (opcional) sin los ya ofertados. Lo usan el matcher secuencial (FIXED) y el broadcast del
 * board (PUJA), que antes lo duplicaban byte-a-byte. El ranking/scoring lo hace el llamador.
 *
 * (D de SOLID: depende de los puertos HotIndex/ExclusionRegistry, no de Redis directamente.)
 */
import { Inject, Injectable } from '@nestjs/common';
import type { VehicleClass } from '@veo/shared-types';
import {
  HOT_INDEX,
  EXCLUSION_REGISTRY,
  type HotIndex,
  type ExclusionRegistry,
  type DriverLocation,
} from '../hot-index/hot-index.port';

@Injectable()
export class DriverPool {
  constructor(
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
  ) {}

  /**
   * Conductores elegibles en las celdas dadas para un viaje: disponibles (ubicación viva en el
   * hot-index), del `vehicleType` requerido, NO excluidos por pánico y —si se pasa `exclude`— sin los
   * conductores ya ofertados. Preserva el orden del hot-index (el scoring lo decide el llamador).
   */
  async eligible(
    cells: string[],
    vehicleType: VehicleClass,
    opts: { exclude?: ReadonlySet<string> } = {},
  ): Promise<DriverLocation[]> {
    const available = await this.hotIndex.candidates(cells);
    const byType = available.filter((l) => l.vehicleType === vehicleType);
    const exclude = opts.exclude;
    const fresh = exclude ? byType.filter((l) => !exclude.has(l.driverId)) : byType;
    const allowed = new Set(await this.exclusion.filter(fresh.map((l) => l.driverId)));
    return fresh.filter((l) => allowed.has(l.driverId));
  }
}
