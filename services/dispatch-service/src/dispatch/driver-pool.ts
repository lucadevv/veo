/**
 * DriverPool — selección de candidatos ELEGIBLES para un viaje (BR-T06). ÚNICA fuente de verdad del
 * pipeline de filtrado: candidatos del hot-index → del tipo de vehículo requerido → NO excluidos por
 * pánico → (opcional) sin los ya ofertados. Lo usan el matcher secuencial (FIXED) y el broadcast del
 * board (PUJA), que antes lo duplicaban byte-a-byte. El ranking/scoring lo hace el llamador.
 *
 * (D de SOLID: depende de los puertos HotIndex/ExclusionRegistry, no de Redis directamente.)
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  hasRequiredCertifications,
  isVehicleEligibleForOffering,
  type OfferingRequirements,
  type VehicleClass,
} from '@veo/shared-types';
import {
  HOT_INDEX,
  EXCLUSION_REGISTRY,
  SUSPENSION_REGISTRY,
  type HotIndex,
  type ExclusionRegistry,
  type DriverLocation,
} from '../hot-index/hot-index.port';
import {
  bumpEligibilityFailOpen,
  bumpEligibilityTierEvaluation,
  classifyMissingAttr,
  offeringRestrictsByVehicleAttrs,
} from './dispatch.metrics';
import { OperableVehicleClassesProvider } from './operable-vehicle-classes.provider';

@Injectable()
export class DriverPool {
  constructor(
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
    @Inject(SUSPENSION_REGISTRY) private readonly suspension: ExclusionRegistry,
    // FILTRO DEFENSIVO de clase operable (seam catálogo↔operabilidad · ADR 013). OPCIONAL: los tests que no lo
    // ejercen construyen el pool sin él y el filtro se salta (undefined) → comportamiento histórico. En producción
    // lo inyecta el módulo. Es defensa en profundidad SECUNDARIA (el mecanismo primario son los holds de identity).
    @Optional() private readonly operableClasses?: OperableVehicleClassesProvider,
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
    // FILTRO DEFENSIVO (seam catálogo↔operabilidad · ADR 013): si la CLASE del viaje no está operable en el
    // catálogo efectivo del admin, ningún conductor de esa clase debe recibir la oferta. SECUNDARIO/redundante en
    // el happy-path (una categoría off no genera viajes) — cierra el hueco de un conductor de la clase apagada que
    // quedara en el hot-index sin hold aún. El provider degrada CONSERVADOR (default estático) si trip-service cae,
    // y es OPCIONAL (los tests que no lo cablean saltan el filtro). Como `byType` ya es de UNA sola clase, esto es
    // all-or-nothing sobre `vehicleType`; se filtra por-conductor por robustez si el pool trajera clases mezcladas.
    const classFiltered = await this.filterByOperableClass(byType);
    const exclude = opts.exclude;
    const fresh = exclude ? classFiltered.filter((l) => !exclude.has(l.driverId)) : classFiltered;
    // Dos exclusiones de ciclo de vida distinto, AMBAS sacan del pool: pánico (BR-T06) y suspensión del
    // conductor. Un suspendido que sigue pingeando GPS permanece en el hot-index pero NO debe recibir
    // ofertas FIXED — el accept ya lo frena (EligibilityGate, fail-closed), esto evita ofertarle de gusto.
    const notPanicked = await this.exclusion.filter(fresh.map((l) => l.driverId));
    const allowed = new Set(await this.suspension.filter(notPanicked));
    return fresh.filter((l) => allowed.has(l.driverId));
  }

  /**
   * Filtro defensivo de clase operable (seam catálogo↔operabilidad · ADR 013). Si el provider NO está inyectado
   * (tests que no lo ejercen) devuelve el pool intacto (comportamiento histórico). Si está, resuelve las clases
   * operables del catálogo efectivo (cache corto, degradación conservadora, NUNCA lanza) y excluye a los
   * conductores cuya `vehicleType` no esté en el set. Pool vacío o provider ausente → sin trabajo extra.
   */
  private async filterByOperableClass(pool: DriverLocation[]): Promise<DriverLocation[]> {
    if (!this.operableClasses || pool.length === 0) return pool;
    const operable = new Set<VehicleClass>(await this.operableClasses.get());
    return pool.filter((l) => operable.has(l.vehicleType));
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
    // Certs: FAIL-CLOSED — se evalúa SIEMPRE (eje ortogonal a los attrs del vehículo).
    if (!hasRequiredCertifications(requires, loc.certifications)) return false;
    // ¿La oferta restringe por ATRIBUTOS del vehículo? Si NO (ej. vertical certs-only: ambulancia/grúa, que
    // gatea por credencial y no por asientos/segmento/año), un attr ausente es IRRELEVANTE para esta oferta:
    // no se mide ni cae a fail-open (no inflar el numerador con fugas inexistentes; no falso-excluir en un flip).
    if (!offeringRestrictsByVehicleAttrs(requires)) return true;
    // DENOMINADOR de la prevalencia: esta evaluación SÍ podría caer a fail-open (la oferta tier-gatea por attrs).
    bumpEligibilityTierEvaluation('pool');
    // Attrs del vehículo: FAIL-OPEN — sin el dato no se restringe.
    if (loc.seats === undefined || loc.segment === undefined || loc.vehicleYear === undefined) {
      // OBSERVABILIDAD (CERO cambio de comportamiento): el fail-open dispara — un vehículo con attrs
      // ausentes pasa para una oferta con requisitos. La prevalencia (numerador/denominador) mide cuánto pasa
      // en tráfico real antes de flipear a fail-closed (el cambio de matching en vivo necesita el gate
      // adversarial). `source=pool`: barrido AMPLIO de candidatos (FIXED + broadcast de PUJA), muestra de flota.
      bumpEligibilityFailOpen(
        'pool',
        classifyMissingAttr({
          seats: loc.seats !== undefined,
          segment: loc.segment !== undefined,
          year: loc.vehicleYear !== undefined,
        }),
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
