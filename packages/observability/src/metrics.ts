/**
 * Métricas Prometheus (FOUNDATION §5). Registry compartido + métricas estándar.
 * Cada servicio expone GET /metrics (MetricsController) y registra default metrics.
 */
import { Registry, collectDefaultMetrics, Histogram, Counter } from 'prom-client';

export const metricsRegistry = new Registry();

let defaultsCollected = false;

export function initDefaultMetrics(service: string): void {
  metricsRegistry.setDefaultLabels({ service });
  if (!defaultsCollected) {
    collectDefaultMetrics({ register: metricsRegistry });
    defaultsCollected = true;
  }
}

/** Duración de requests HTTP. */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de requests HTTP en segundos',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/** Eventos de dominio publicados/consumidos. */
export const domainEventsTotal = new Counter({
  name: 'domain_events_total',
  help: 'Eventos de dominio por tipo y resultado',
  labelNames: ['event', 'result'] as const,
  registers: [metricsRegistry],
});

/** Errores por código de dominio. */
export const errorsTotal = new Counter({
  name: 'errors_total',
  help: 'Errores por código',
  labelNames: ['code', 'status'] as const,
  registers: [metricsRegistry],
});
