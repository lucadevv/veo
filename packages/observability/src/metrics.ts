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

/**
 * Resultados de TRANSPORTE de un evento de dominio, emitidos por la capa BASE de Kafka
 * (KafkaEventProducer.publish + KafkaEventConsumer.eachMessage en @veo/events). Son la label
 * `result` de `domainEventsTotal`. Cero strings mágicos: usá SIEMPRE este const.
 *
 * CONVENCIÓN (ortogonalidad, NO se pisan):
 * - El BASE emite SÓLO resultados de TRANSPORTE: published/publish_failed (producer) y
 *   consumed/error/invalid/poison (consumer). Es lo que le pasó al evento en el riel Kafka.
 * - Los HANDLERS de negocio pueden emitir su PROPIO `result` con labels DISTINTOS
 *   (no_driver/emitted/recorded/ok/...). Es OTRA dimensión semántica (qué decidió el negocio),
 *   ortogonal al transporte. Conviven en la misma métrica sin colisionar porque los valores
 *   de `result` no se solapan. No mezclar: el transporte no opina de negocio y viceversa.
 */
export const EventResult = {
  CONSUMED: 'consumed',
  ERROR: 'error',
  INVALID: 'invalid',
  POISON: 'poison',
  PUBLISHED: 'published',
  PUBLISH_FAILED: 'publish_failed',
  UNKNOWN: 'unknown',
} as const;
export type EventResult = (typeof EventResult)[keyof typeof EventResult];

/**
 * Resultados de NEGOCIO de un evento — la OTRA dimensión de `result` en `domainEventsTotal`, emitida
 * por los HANDLERS (no por el base). Responde "qué decidió el negocio con el mensaje", ortogonal al
 * transporte. Cero strings mágicos: usá SIEMPRE este const en los call-sites de handler.
 *
 * INVARIANTE (la disjunción que evita la colisión): los valores de BusinessEventResult son DISJUNTOS
 * de los de EventResult — NINGÚN valor compartido. Un handler que retorna normal SIEMPRE recibe CONSUMED
 * del base ENCIMA de su label de negocio; si reusara 'error'/'consumed'/'invalid'/'poison'/'published',
 * el MISMO mensaje quedaría contado con dos significados contradictorios de `result` (transporte vs
 * negocio) → métrica ambigua que PARECE doble-conteo. Por eso los conjuntos no se solapan:
 *   - EMITTED        — se entregó al destino (socket/cliente). Camino feliz del fan-out.
 *   - NO_DRIVER      — no había conductor al cual entregar (no es error: estado de negocio).
 *   - DELIVERY_FAILED— falló la entrega realtime al socket (best-effort: el cliente re-sincroniza al
 *                      reconectar). NO es ERROR de transporte: el mensaje Kafka se procesó OK (offset
 *                      commiteado), el base emite CONSUMED igual.
 *   - REJECTED       — el handler RECHAZÓ data permanentemente mala (ej. UUID inválido) y la descartó
 *                      (skip correcto, no reintenta). NO es el POISON del base (body no-JSON): el evento
 *                      SÍ era JSON válido; fue la regla de negocio la que lo rechazó.
 *   - BAD_REQUEST    — entrada de negocio inválida en un path NO-Kafka (gRPC/HTTP). Distinto del INVALID
 *                      de transporte (payload que no matchea su schema en el consumer Kafka).
 *   - OK / RECORDED / RECONCILED / SKIPPED — desenlaces de negocio de paths gRPC / proyecciones.
 *   - DUPLICATE — el evento ya estaba registrado (idempotencia): no se re-aplicó. Desenlace de negocio,
 *                 distinto de RECORDED (primera vez) — ambos son "consumed" a nivel transporte.
 */
export const BusinessEventResult = {
  EMITTED: 'emitted',
  NO_DRIVER: 'no_driver',
  DELIVERY_FAILED: 'delivery_failed',
  REJECTED: 'rejected',
  BAD_REQUEST: 'bad_request',
  OK: 'ok',
  RECORDED: 'recorded',
  DUPLICATE: 'duplicate',
  RECONCILED: 'reconciled',
  SKIPPED: 'skipped',
} as const;
export type BusinessEventResult = (typeof BusinessEventResult)[keyof typeof BusinessEventResult];

/**
 * Sentinela para la label `event` cuando NO hay un eventType confiable: body poison (no-JSON) o
 * envelope corrupto (safeParse falló). No inventamos un tipo: marcamos el evento como desconocido.
 */
export const UNKNOWN_EVENT = 'unknown' as const;

/** Errores por código de dominio. */
export const errorsTotal = new Counter({
  name: 'errors_total',
  help: 'Errores por código',
  labelNames: ['code', 'status'] as const,
  registers: [metricsRegistry],
});
