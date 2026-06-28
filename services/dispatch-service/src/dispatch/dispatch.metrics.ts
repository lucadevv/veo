/**
 * Métricas Prometheus propias del dispatch-service (FOUNDATION §5 · observabilidad antes de features).
 *
 * Esta métrica MIDE —sin cambiar comportamiento— la exposición del eslabón vehículo↔oferta en el matching,
 * ANTES de flipear la degradación a fail-closed (el cambio de matching en vivo necesita pasar el gate
 * adversarial; mientras tanto, medimos cuánto pasa en tráfico real para decidir con datos):
 *  - C1: el FAIL-OPEN de atributos en la elegibilidad (driver-pool) — un vehículo sin seats/segment/año en el
 *    ping pasa para una oferta con requisitos sin verificar el tier.
 *
 * (C2 — el carril PUJA corría la elegibilidad SIN los `requires` de la oferta porque el board no llevaba
 * `category` — quedó CERRADO: el board ahora transporta `category` y el gate enforça el TIER en PUJA igual
 * que en FIXED, así que la métrica de exposición ya no tiene sentido y se eliminó.)
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
 * C1 · Veces que la elegibilidad por ATRIBUTOS del vehículo cayó a FAIL-OPEN: el ping no traía
 * seats/segment/año y la oferta tenía requisitos, así que el vehículo pasó SIN verificar el tier
 * (Confort/XL/Premium). Un valor alto = muchos vehículos legacy/sin-modelSpec colándose a ofertas que no les
 * tocan → señal para priorizar el flip a fail-closed. Por `missing` (qué atributo faltó).
 */
const eligibilityFailOpenTotal: CounterLike = getOrCreateCounter(
  'dispatch_eligibility_fail_open_total',
  'Elegibilidad por atributos que cayó a FAIL-OPEN (ping sin seats/segment/año, oferta con requisitos): el ' +
    'vehículo pasó sin verificar el tier. Mide la exposición del eslabón vehículo↔oferta antes del fail-closed.',
  ['missing'] as const,
);

/** Bumpea el contador del fail-open de atributos (C1), etiquetado por el atributo que faltó. */
export function bumpEligibilityFailOpen(missing: 'seats' | 'segment' | 'year' | 'multiple'): void {
  eligibilityFailOpenTotal.inc({ missing });
}
