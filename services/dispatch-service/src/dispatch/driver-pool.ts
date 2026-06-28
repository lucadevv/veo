/**
 * DriverPool — selección de candidatos ELEGIBLES para un viaje (BR-T06). ÚNICA fuente de verdad del
 * pipeline de filtrado: candidatos del hot-index → del tipo de vehículo requerido → NO excluidos por
 * pánico → (opcional) sin los ya ofertados. Lo usan el matcher secuencial (FIXED) y el broadcast del
 * board (PUJA), que antes lo duplicaban byte-a-byte. El ranking/scoring lo hace el llamador.
 *
 * (D de SOLID: depende de los puertos HotIndex/ExclusionRegistry, no de Redis directamente.)
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  hasRequiredCertifications,
  isVehicleEligibleForOffering,
  type OfferingRequirements,
  type VehicleClass,
} from '@veo/shared-types';
import {
  HOT_INDEX,
  EXCLUSION_REGISTRY,
  type HotIndex,
  type ExclusionRegistry,
  type DriverLocation,
} from '../hot-index/hot-index.port';
import { bumpEligibilityFailOpen } from './dispatch.metrics';

@Injectable()
export class DriverPool {
  constructor(
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
  ) {}

  /**
   * Conductores elegibles en las celdas dadas para un viaje: disponibles (ubicación viva en el
   * hot-index), del `vehicleType` requerido, que SATISFACEN los requisitos de la oferta (`requires`,
   * B5-3: confort=segment≥MID, xl=6 asientos), NO excluidos por pánico y —si se pasa `exclude`— sin los
   * ya ofertados. Preserva el orden del hot-index (el scoring lo decide el llamador).
   */
  async eligible(
    cells: string[],
    vehicleType: VehicleClass,
    opts: { exclude?: ReadonlySet<string>; requires?: OfferingRequirements } = {},
  ): Promise<DriverLocation[]> {
    const available = await this.hotIndex.candidates(cells);
    const currentYear = new Date().getUTCFullYear();
    const byType = available.filter(
      (l) => l.vehicleType === vehicleType && this.passesEligibility(l, opts.requires, currentYear),
    );
    const exclude = opts.exclude;
    const fresh = exclude ? byType.filter((l) => !exclude.has(l.driverId)) : byType;
    const allowed = new Set(await this.exclusion.filter(fresh.map((l) => l.driverId)));
    return fresh.filter((l) => allowed.has(l.driverId));
  }

  /**
   * ¿El conductor satisface los requisitos de la oferta? Dos degradaciones DISTINTAS por diseño:
   *
   *  - ATRIBUTOS del vehículo (seats/segment/antigüedad) → FAIL-OPEN: si el ping no los trae (legacy/
   *    productor sin desplegar) NO se excluye a nadie — un auto sin attrs conocidos igual puede dar un
   *    viaje normal; el matching no se rompe en el rollout.
   *  - CERTIFICACIONES del conductor (B5-3.2) → FAIL-CLOSED: una vertical (ambulancia/grúa/mecánico) exige
   *    una credencial de operador VÁLIDA; si el conductor no la tiene (o el ping no trae certs) NO es
   *    elegible. Una cert es un gate de seguridad/legal: la AUSENCIA de dato NO habilita. Esto cierra el
   *    hueco donde `requires.certifications` era decorativo (el pool lo ignoraba).
   *
   * Una oferta sin `requires` o sin certs requeridas no se ve afectada (hasRequiredCertifications → true).
   */
  private passesEligibility(
    loc: DriverLocation,
    requires: OfferingRequirements | undefined,
    currentYear: number,
  ): boolean {
    if (!requires) return true;
    // Certs: FAIL-CLOSED — se evalúa SIEMPRE (independiente de los attrs del vehículo).
    if (!hasRequiredCertifications(requires, loc.certifications)) return false;
    // Attrs del vehículo: FAIL-OPEN — sin el dato no se restringe.
    if (loc.seats === undefined || loc.segment === undefined || loc.vehicleYear === undefined) {
      // OBSERVABILIDAD (C1, CERO cambio de comportamiento): el fail-open dispara — un vehículo con attrs
      // ausentes pasa para una oferta con requisitos. Medimos cuánto pasa en tráfico real antes de flipear a
      // fail-closed (el cambio de matching en vivo necesita el gate adversarial). Etiquetamos QUÉ atributo faltó.
      const missingCount =
        (loc.seats === undefined ? 1 : 0) +
        (loc.segment === undefined ? 1 : 0) +
        (loc.vehicleYear === undefined ? 1 : 0);
      bumpEligibilityFailOpen(
        missingCount > 1
          ? 'multiple'
          : loc.seats === undefined
            ? 'seats'
            : loc.segment === undefined
              ? 'segment'
              : 'year',
      );
      return true;
    }
    return isVehicleEligibleForOffering(
      requires,
      { seats: loc.seats, segment: loc.segment, year: loc.vehicleYear },
      currentYear,
    );
  }
}
