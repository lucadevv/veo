/**
 * Métricas Prometheus del catálogo en fleet-service. Se registran en el registry compartido de
 * @veo/observability (lo expone GET /metrics; initDefaultMetrics('fleet-service') agrega el label
 * `service`).
 *
 * `veo_catalog_degraded_total` — el catálogo EFECTIVO de ofertas de trip-service NO respondió y fleet
 * cayó al fallback CONSERVADOR (degradación honesta: el gate de operabilidad por clase usa el default
 * estático de código `OPERABLE_VEHICLE_CLASSES` en vez del overlay del admin). MISMO nombre de métrica
 * que trip-service/src/trips/trip-metrics.ts y public-bff/src/maps/maps-metrics.ts (un solo contrato
 * cross-servicio: el dashboard agrega por `service` + `site`). La degradación es silenciosa para el alta
 * a propósito (nunca se crashea el registro por una config caída), pero NO para Ops — este counter la
 * hace alertable.
 *
 * Mismo patrón que maps-metrics.ts / trip-metrics.ts: fleet no declara `prom-client` como dep directa;
 * tomamos la clase Counter de una métrica existente (domainEventsTotal) para registrar en el registry
 * correcto. Módulo-level (sin DI): bumpea igual en producción y en tests sin importar qué providers se
 * inyectaron.
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

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

export const CATALOG_DEGRADED_METRIC = 'veo_catalog_degraded_total';

/** Punto del flujo de fleet donde el catálogo efectivo degradó (label BOUNDED). */
export type CatalogDegradedSite = 'operable_classes';

const catalogDegradedTotal: CounterLike = getOrCreateCounter(
  CATALOG_DEGRADED_METRIC,
  'Veces que el catálogo efectivo de ofertas no respondió y fleet cayó al fallback estático (degradación honesta)',
  ['site'],
);

/** Bumpea el counter de degradación del catálogo (acompaña al warn estructurado en cada catch). */
export function bumpCatalogDegraded(site: CatalogDegradedSite): void {
  catalogDegradedTotal.inc({ site });
}
