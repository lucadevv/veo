/**
 * Métricas Prometheus propias de trips (FOUNDATION §5). Se registran en el registry compartido de
 * @veo/observability (lo expone GET /metrics).
 *
 * ADR 013 §1.3.3 — `pricing_offering_mode_overridden_total`: el schedule del admin pidió un modo que
 * la oferta NO permite y ganó la oferta (`allowedModes[0]`). El counter hace el conflicto VISIBLE al
 * admin en vez de silencioso ("la ambulancia no negocia" es invariante de dominio, no esperanza de
 * configuración). El sufijo `_total` sigue la convención Prometheus del repo (domain_events_total,
 * errors_total); el ADR lo nombra sin sufijo (`pricing_offering_mode_overridden`).
 *
 * Nota (mismo patrón que panic-service/src/metrics/panic.metrics.ts): trip-service no declara
 * `prom-client` como dependencia directa. Para crear el counter reutilizamos la MISMA instancia del
 * módulo prom-client que ya usa @veo/observability, obteniendo la clase Counter desde una métrica
 * existente (domainEventsTotal). Así queda registrado en el registry correcto sin una dep nueva.
 * Es módulo-level (sin DI): TripsService soporta construcción SIN Nest (tests legacy) y el counter
 * debe bumpear igual en producción sin depender de qué providers se inyectaron.
 */
import { domainEventsTotal, metricsRegistry } from '@veo/observability';

/** Labels del override de modo por oferta (ADR 013 §1.3.3). */
export interface OfferingModeOverriddenLabels extends Record<string, string> {
  /** Id de la oferta que vetó al schedule (p.ej. veo_moto). */
  offering: string;
  /** Modo que pidió el schedule del admin. */
  scheduledMode: string;
  /** Modo EFECTIVO (el preferido de la oferta, allowedModes[0]). */
  mode: string;
}

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

export const OFFERING_MODE_OVERRIDDEN_METRIC = 'pricing_offering_mode_overridden_total';

function getOrCreateCounter(name: string, help: string, labelNames: readonly string[]): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

/** Counter del conflicto schedule↔oferta (ADR 013 §1.3.3). Exportado para que los specs lean su valor. */
export const offeringModeOverriddenTotal: CounterLike = getOrCreateCounter(
  OFFERING_MODE_OVERRIDDEN_METRIC,
  'Veces que la oferta vetó el modo del schedule (ADR 013 §1.3.3: gana allowedModes[0] de la oferta)',
  ['offering', 'scheduledMode', 'mode'],
);

/** Bumpea el counter del override (warn estructurado + métrica = observabilidad del conflicto). */
export function bumpOfferingModeOverridden(labels: OfferingModeOverriddenLabels): void {
  offeringModeOverriddenTotal.inc(labels);
}
