/**
 * Métrica de observabilidad del cost-cap del carpooling (F2.5 · ADR-017 §1.4). El tope legal anti-lucro (F1b)
 * deriva del precio de energía VIVO de trip-service; si esa fuente cae o está mal configurada, el cost-cap
 * DEGRADA al env `COST_PER_KM_CENTS_PE` (placeholder, NO validado por legal/finanzas). Esa degradación NO
 * debe ser silenciosa: este counter la hace VISIBLE y alertable — un valor SOSTENIDO distingue un misconfig
 * PERMANENTE del escudo legal (URL/HMAC/404) de un corte transitorio de trip-service.
 *
 * Mismo patrón que trip-service/trip-metrics.ts: tomamos la clase Counter de la instancia de prom-client que
 * ya usa @veo/observability (sin dep nueva), registrada en el registry que expone GET /metrics. Módulo-level
 * (sin DI): el counter bumpea igual en prod sin depender de qué providers se inyectaron.
 */
import { domainEventsTotal, metricsRegistry } from '@veo/observability';

interface CounterLike {
  inc(labels?: Record<string, string>, value?: number): void;
  get(): Promise<{ values: { value: number; labels: Record<string, string | number> }[] }>;
}
type CounterCtor = new (cfg: {
  name: string;
  help: string;
  labelNames: readonly string[];
  registers: unknown[];
}) => CounterLike;

// Clase Counter tomada de la instancia existente (misma copia de prom-client que @veo/observability).
const CounterClass = (domainEventsTotal as unknown as { constructor: CounterCtor }).constructor;

export const COST_PER_KM_DEGRADED_METRIC = 'carpooling_cost_per_km_degraded_total';

/** Por qué el cost/km vivo no se pudo usar y el tope cayó al env placeholder. */
export type CostPerKmDegradedReason = 'trip_unreachable' | 'no_price' | 'degenerate';

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

/** Counter de la degradación del cost/km del cost-cap. Exportado para que los specs lean su valor. */
export const costPerKmDegradedTotal: CounterLike = getOrCreateCounter(
  COST_PER_KM_DEGRADED_METRIC,
  'Veces que el cost-cap del carpooling degradó al env placeholder por no poder usar el precio de energía ' +
    'vivo (F2.5). Valor SOSTENIDO = misconfig permanente del escudo legal anti-lucro, no un corte transitorio.',
  ['reason'],
);

/** Bumpea el counter de degradación (+ el caller logea estructurado = observabilidad completa). */
export function bumpCostPerKmDegraded(reason: CostPerKmDegradedReason): void {
  costPerKmDegradedTotal.inc({ reason });
}
