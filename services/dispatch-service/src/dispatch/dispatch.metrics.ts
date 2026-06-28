/**
 * Métricas Prometheus propias del dispatch-service (FOUNDATION §5 · observabilidad antes de features).
 *
 * Estas dos métricas MIDEN —sin cambiar comportamiento— la exposición del eslabón vehículo↔oferta en el
 * matching, ANTES de flipear las degradaciones a fail-closed (el cambio de matching en vivo necesita pasar
 * el gate adversarial; mientras tanto, medimos cuánto pasa en tráfico real para decidir con datos):
 *  - C1: el FAIL-OPEN de atributos en la elegibilidad (driver-pool) — un vehículo sin seats/segment/año en el
 *    ping pasa para una oferta con requisitos sin verificar el tier.
 *  - C2: el carril PUJA (offer-board) corre la elegibilidad SIN los `requires` de la oferta (el board no lleva
 *    category), así que segment/asientos NO se evalúan, a diferencia del carril FIXED.
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

/**
 * C2 · Broadcasts del carril PUJA cuya elegibilidad corrió SIN los `requires` de la oferta. Hoy el board no
 * lleva `category`, así que `eligible()` se llama solo con `vehicleType` → segment/asientos NO se evalúan (a
 * diferencia del carril FIXED, que sí deriva requires). Mide la exposición del tier en PUJA antes de cablear
 * los requires al board. Por `vehicleType`.
 */
const pujaRequiresSkippedTotal: CounterLike = getOrCreateCounter(
  'dispatch_puja_requires_skipped_total',
  'Broadcasts del carril PUJA cuya elegibilidad corrió SIN los requisitos de la oferta (el board no lleva ' +
    'category → segment/asientos no se evalúan, a diferencia de FIXED). Mide la exposición del tier en PUJA.',
  ['vehicleType'] as const,
);

/** Bumpea el contador de PUJA-sin-requires (C2), etiquetado por la clase de vehículo del board. */
export function bumpPujaRequiresSkipped(vehicleType: string): void {
  pujaRequiresSkippedTotal.inc({ vehicleType });
}
