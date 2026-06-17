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

/**
 * ADR 013 · Fase B — `veo_catalog_degraded_total`: el catálogo de ofertas NO respondió y el código
 * cayó al fallback (degradación honesta). La degradación es silenciosa para el usuario (a propósito:
 * no abortamos un viaje por una lectura de config caída), pero NO debe ser silenciosa para Ops — este
 * counter la hace VISIBLE/alertable. Mismo nombre de métrica en trip-service y public-bff (un solo
 * contrato cross-servicio); el label `service` lo agrega initDefaultMetrics, acá solo el `site`.
 */
export const CATALOG_DEGRADED_METRIC = 'veo_catalog_degraded_total';

/** Punto del flujo donde el catálogo degradó (label BOUNDED, sin cardinalidad libre). */
export type CatalogDegradedSite = 'create' | 'activate';

export const catalogDegradedTotal: CounterLike = getOrCreateCounter(
  CATALOG_DEGRADED_METRIC,
  'Veces que el catálogo de ofertas no respondió y el código cayó al fallback (degradación honesta, ADR 013)',
  ['site'],
);

/** Bumpea el counter de degradación del catálogo (acompaña al warn estructurado en cada catch). */
export function bumpCatalogDegraded(site: CatalogDegradedSite): void {
  catalogDegradedTotal.inc({ site });
}

/**
 * Fase B (auditoría · hardening) — `veo_pricing_config_changed_total`: cada REEMPLAZO exitoso de un
 * singleton de pricing editable en caliente (recargo de combustible, catálogo de ofertas, schedule de
 * modo). Acompaña al `audit.record` (compliance, inmutable) y al log estructurado del PUT: el counter es
 * la señal OPS (dashboard/alerta de "config cambió N veces" o un pico de cambios). FOUNDATION §6.
 */
export const PRICING_CONFIG_CHANGED_METRIC = 'veo_pricing_config_changed_total';

/** Singleton de pricing que cambió (label BOUNDED, sin cardinalidad libre). */
export type PricingConfigKind =
  | 'fuel_surcharge'
  | 'offering_catalog'
  | 'mode_schedule'
  | 'energy_catalog'
  | 'bid_floor';

export const pricingConfigChangedTotal: CounterLike = getOrCreateCounter(
  PRICING_CONFIG_CHANGED_METRIC,
  'Veces que un singleton de pricing (combustible/catálogo/schedule) fue reemplazado con éxito por el admin',
  ['kind'],
);

/** Bumpea el counter de cambio de config de pricing (tras un replace exitoso, junto al audit + log). */
export function bumpPricingConfigChanged(kind: PricingConfigKind): void {
  pricingConfigChangedTotal.inc({ kind });
}
