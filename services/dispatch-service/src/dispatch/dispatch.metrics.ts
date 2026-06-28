/**
 * Métricas Prometheus propias del dispatch-service (FOUNDATION §5 · observabilidad antes de features).
 *
 * Esta métrica MIDE —sin cambiar comportamiento— la exposición del eslabón vehículo↔oferta en el matching,
 * ANTES de flipear la degradación a fail-closed (el cambio de matching en vivo necesita pasar el gate
 * adversarial; mientras tanto, medimos cuánto pasa en tráfico real para decidir con datos). El fail-open de
 * atributos vive en DOS superficies distintas, y el label `source` las separa para no contaminar la señal:
 *  - `pool` (driver-pool.passesEligibility) — el barrido AMPLIO del pool de candidatos (lo usan FIXED y el
 *    broadcast de PUJA). Es la muestra más representativa de la PREVALENCIA de attrs ausentes en la flota.
 *  - `gate` (eligibility.gate · C2) — el gate AUTORITATIVO por-bidder de la PUJA (submit/accept, la decisión
 *    de plata). Mide el BLAST-RADIUS por superficie: cuántos submit/accept se colarían si attrs pasa a
 *    fail-closed. Antes quedaba CIEGO (el gate de C2 agregó este branch y no lo instrumentaba) → asimetría
 *    que el gate adversarial cazó; con `source=gate` la decisión del flip se toma con datos de AMBAS
 *    superficies, no solo del pool. Filtrá por `source` para no doble-contar el mismo `loc`.
 *
 * (El carril PUJA corría la elegibilidad SIN los `requires` de la oferta porque el board no llevaba
 * `category` — quedó CERRADO: el board ahora transporta `category` y el gate enforça el TIER en PUJA igual
 * que en FIXED. Las CERTS siguen siendo FAIL-CLOSED en ambas superficies; solo los attrs son fail-open.)
 *
 * Patrón (igual que payment-service/panic-service): dispatch no declara `prom-client` como dependencia
 * directa. Reutilizamos la MISMA instancia del módulo que ya usa @veo/observability, tomando la clase Counter
 * de una métrica existente (domainEventsTotal, que ES un Counter), así el contador queda en el registry
 * correcto sin acoplar una dependencia nueva. Module-level (sin DI): los callers lo invocan directo.
 */
import { metricsRegistry, domainEventsTotal } from '@veo/observability';
import type { OfferingRequirements } from '@veo/shared-types';

interface CounterLike {
  inc(labels: Record<string, string>): void;
}
type CounterCtor = new (cfg: {
  name: string;
  help: string;
  labelNames: readonly string[];
  registers: unknown[];
}) => CounterLike;

// Clase Counter tomada de la instancia existente (misma copia de prom-client).
const CounterClass = (domainEventsTotal as unknown as { constructor: CounterCtor }).constructor;

function getOrCreateCounter(name: string, help: string, labelNames: readonly string[]): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

/**
 * Veces que la elegibilidad por ATRIBUTOS del vehículo cayó a FAIL-OPEN: el ping no traía
 * seats/segment/año y la oferta tenía requisitos, así que el vehículo pasó SIN verificar el tier
 * (Confort/XL/Premium). Un valor alto = muchos vehículos legacy/sin-modelSpec colándose a ofertas que no les
 * tocan → señal para priorizar el flip a fail-closed. Etiquetado por `source` (pool=barrido amplio /
 * gate=gate autoritativo de PUJA) y `missing` (qué atributo faltó).
 */
const eligibilityFailOpenTotal: CounterLike = getOrCreateCounter(
  'dispatch_eligibility_fail_open_total',
  'Elegibilidad por atributos que cayó a FAIL-OPEN (ping sin seats/segment/año, oferta con requisitos): el ' +
    'vehículo pasó sin verificar el tier. Mide la exposición del eslabón vehículo↔oferta antes del fail-closed. ' +
    'source=pool (prevalencia de flota) | gate (blast-radius del gate autoritativo de PUJA).',
  ['source', 'missing'] as const,
);

/** Superficie donde se disparó el fail-open: el barrido amplio del pool o el gate autoritativo de PUJA. */
export type FailOpenSource = 'pool' | 'gate';

/** Qué atributo de tier faltó en el ping (label del fail-open); `multiple` si faltó más de uno. */
export type MissingAttr = 'seats' | 'segment' | 'year' | 'multiple';

/**
 * Clasifica QUÉ atributo de tier faltó, para el label del fail-open. Compartido por las dos superficies
 * (driver-pool y eligibility.gate) para no duplicar la lógica de clasificación.
 */
export function classifyMissingAttr(present: {
  seats: boolean;
  segment: boolean;
  year: boolean;
}): MissingAttr {
  const missingCount =
    (present.seats ? 0 : 1) + (present.segment ? 0 : 1) + (present.year ? 0 : 1);
  if (missingCount > 1) return 'multiple';
  if (!present.seats) return 'seats';
  if (!present.segment) return 'segment';
  return 'year';
}

/** Bumpea el contador del fail-open de atributos, etiquetado por superficie y por el atributo que faltó. */
export function bumpEligibilityFailOpen(source: FailOpenSource, missing: MissingAttr): void {
  eligibilityFailOpenTotal.inc({ source, missing });
}

/**
 * DENOMINADOR de la prevalencia (cierra el hueco MEDIA del gate adversarial: antes solo existía el
 * NUMERADOR `dispatch_eligibility_fail_open_total` → un conteo absoluto NO normalizable: 1000 fail-opens
 * podían ser el 1% o el 50%). Cuenta CADA evaluación de elegibilidad sobre una oferta que SÍ restringe por
 * atributos del vehículo (la población que PODRÍA caer a fail-open). Así:
 *
 *   prevalencia(source) = dispatch_eligibility_fail_open_total{source} / dispatch_eligibility_tier_evaluations_total{source}
 *
 * Clave del diseño: el denominador se cuenta con la MISMA granularidad que el numerador (una vez por
 * candidato-por-evaluación). Eso hace el RATIO invariante a la densidad por zona (cierra el sesgo BAJA del
 * conteo per-evaluación): una celda caliente con muchos legacy infla numerador Y denominador por igual, el
 * cociente no se mueve. El conteo ABSOLUTO sigue sesgado por zona, pero la PREVALENCIA —que es lo que decide
 * el flip— no. Etiquetado por `source` (pool=flota / gate=blast-radius de PUJA), igual que el numerador.
 */
const eligibilityTierEvaluationsTotal: CounterLike = getOrCreateCounter(
  'dispatch_eligibility_tier_evaluations_total',
  'Evaluaciones de elegibilidad sobre ofertas que restringen por atributos del vehículo (denominador de la ' +
    'prevalencia del fail-open). prevalencia = fail_open_total / tier_evaluations_total, invariante a la ' +
    'densidad por zona. source=pool (flota) | gate (blast-radius de PUJA).',
  ['source'] as const,
);

/**
 * El gate AUTORITATIVO de PUJA recibe la oferta como `category` (string) y resuelve sus `requires` por
 * catálogo. Si NO puede resolver el tier, NO hay forma de gatear por atributos: es el fail-open MÁS AMPLIO
 * (cero verificación de tier), y antes quedaba INVISIBLE (el `auditar-core` lo marcó como residual a mirar a
 * mano). Lo medimos para que el blind-spot deje de serlo, separado por `reason`:
 *   - `absent`  → el board no llevó `category` (compat N-2; debería tender a 0 a medida que el rollout limpia).
 *   - `unknown` → `category` llegó pero el catálogo no la conoce (gap de catálogo / drift) → señal de alarma.
 * NO entra en el denominador de prevalencia (ahí el tier es CONOCIDO): es una población distinta (tier
 * irresoluble), su propia señal de cobertura del board/catálogo.
 */
const eligibilityTierUnknownTotal: CounterLike = getOrCreateCounter(
  'dispatch_eligibility_tier_unknown_total',
  'Evaluaciones del gate de PUJA donde el tier de la oferta NO se pudo resolver (fail-open más amplio: cero ' +
    'verificación de tier). reason=absent (board sin category, compat N-2) | unknown (category fuera del catálogo).',
  ['reason'] as const,
);

/** Por qué no se pudo resolver el tier de la oferta en el gate de PUJA. */
export type TierUnknownReason = 'absent' | 'unknown';

/**
 * ¿La oferta restringe por ATRIBUTOS del vehículo (asientos/segmento/antigüedad)? Solo entonces un attr
 * ausente es un fail-open REAL y debe contar (numerador + denominador). Una oferta SIN requisitos de attrs
 * —ej. las verticales certs-only (ambulancia/grúa/mecánico), que gatean por certificación y NO por
 * asientos/segmento/año— NO tier-gatea por attrs: medir su "attr ausente" inflaría el numerador con fugas
 * inexistentes Y un flip naïve a fail-closed las falso-excluiría por un atributo que nunca pidieron. Las
 * certs son un eje ORTOGONAL (fail-closed, evaluado aparte). Espejo local de la forma de `OfferingRequirements`
 * (minSeats/minSegment/maxAgeYears = los ejes de attrs del vehículo). DEUDA: promover a `@veo/shared-types`
 * (catálogo) como fuente única cuando toque un build; hoy local para no rebuildear el paquete compartido.
 */
export function offeringRestrictsByVehicleAttrs(requires: OfferingRequirements | undefined): boolean {
  if (!requires) return false;
  return (
    requires.minSeats !== undefined ||
    requires.minSegment !== undefined ||
    requires.maxAgeYears !== undefined
  );
}

/** Bumpea el DENOMINADOR de la prevalencia: una evaluación sobre una oferta que tier-gatea por attrs. */
export function bumpEligibilityTierEvaluation(source: FailOpenSource): void {
  eligibilityTierEvaluationsTotal.inc({ source });
}

/** Bumpea el contador del tier irresoluble en el gate de PUJA (fail-open más amplio), por razón. */
export function bumpEligibilityTierUnknown(reason: TierUnknownReason): void {
  eligibilityTierUnknownTotal.inc({ reason });
}
