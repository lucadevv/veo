/**
 * Métricas Prometheus de maps (public-bff). Se registran en el registry compartido de
 * @veo/observability (lo expone GET /metrics; initDefaultMetrics('public-bff') agrega el label
 * `service`).
 *
 * ADR 013 · Fase B — `veo_catalog_degraded_total`: el catálogo de ofertas del trip-service NO
 * respondió y el BFF cayó al fallback (degradación honesta: el quote cotiza TODAS las ofertas / la
 * teaser usa el catálogo de código). MISMO nombre de métrica que trip-service/src/trips/trip-metrics.ts
 * (un solo contrato cross-servicio: el dashboard agrega por `service` + `site`). La degradación es
 * silenciosa para el usuario a propósito, pero NO para Ops — este counter la hace alertable.
 *
 * Mismo patrón que trip-metrics.ts / panic.metrics.ts: public-bff no declara `prom-client` como dep
 * directa; tomamos la clase Counter de una métrica existente (domainEventsTotal) para registrar en el
 * registry correcto. Módulo-level (sin DI): bumpea igual en producción y en tests sin importar qué
 * providers se inyectaron.
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

const CounterClass = (domainEventsTotal as unknown as { constructor: CounterCtor }).constructor;

function getOrCreateCounter(name: string, help: string, labelNames: readonly string[]): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

export const CATALOG_DEGRADED_METRIC = 'veo_catalog_degraded_total';

/** Punto del flujo del BFF donde el catálogo degradó (label BOUNDED). */
export type CatalogDegradedSite = 'quote' | 'teaser';

export const catalogDegradedTotal: CounterLike = getOrCreateCounter(
  CATALOG_DEGRADED_METRIC,
  'Veces que el catálogo de ofertas no respondió y el código cayó al fallback (degradación honesta, ADR 013)',
  ['site'],
);

/** Bumpea el counter de degradación del catálogo (acompaña al warn estructurado en cada catch). */
export function bumpCatalogDegraded(site: CatalogDegradedSite): void {
  catalogDegradedTotal.inc({ site });
}
