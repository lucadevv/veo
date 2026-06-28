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
