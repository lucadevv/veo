/**
 * Métricas Prometheus propias del panic-service (FOUNDATION §5).
 * La latencia es crítica: el ack al cliente del POST /panic debe ser <800ms p99 (BR-S04).
 * Se registran en el registry compartido de @veo/observability (lo expone GET /metrics).
 *
 * Nota: panic-service no declara `prom-client` como dependencia directa. Para crear histogramas
 * propios reutilizamos la MISMA instancia del módulo prom-client que ya usa @veo/observability,
 * obteniendo la clase Histogram desde una métrica existente (httpRequestDuration). Así el histograma
 * queda registrado en el registry correcto sin acoplar una dependencia nueva.
 */
import { Injectable } from '@nestjs/common';
import { metricsRegistry, httpRequestDuration } from '@veo/observability';

interface HistogramLike {
  observe(value: number): void;
}
type HistogramCtor = new (cfg: {
  name: string;
  help: string;
  buckets: number[];
  registers: unknown[];
}) => HistogramLike;

// Clase Histogram tomada de la instancia existente (misma copia de prom-client).
const HistogramClass = (httpRequestDuration as unknown as { constructor: HistogramCtor })
  .constructor;

/** Buckets en segundos afinados al SLO de <800ms (incluye colas para detectar regresiones). */
const ACK_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1, 2, 5];

function getOrCreateHistogram(name: string, help: string): HistogramLike {
  const existing = metricsRegistry.getSingleMetric(name) as HistogramLike | undefined;
  if (existing) return existing;
  return new HistogramClass({ name, help, buckets: ACK_BUCKETS, registers: [metricsRegistry] });
}

@Injectable()
export class PanicMetrics {
  /** Latencia del ack 202 del POST /panic (persistir + encolar outbox + responder). SLO <800ms p99. */
  private readonly triggerAck: HistogramLike = getOrCreateHistogram(
    'veo_panic_trigger_ack_duration_seconds',
    'Latencia del ack 202 de POST /panic (BR-S04, SLO <800ms p99)',
  );

  /** Latencia del reconocimiento del operador (POST /panic/:id/ack). */
  private readonly operatorAck: HistogramLike = getOrCreateHistogram(
    'veo_panic_operator_ack_duration_seconds',
    'Latencia del reconocimiento del operador (POST /panic/:id/ack)',
  );

  /** Mide el ack del trigger. Devuelve los milisegundos transcurridos (para logging/respuesta). */
  observeTriggerAck(startHrtimeNs: bigint): number {
    const ms = Number(process.hrtime.bigint() - startHrtimeNs) / 1e6;
    this.triggerAck.observe(ms / 1000);
    return ms;
  }

  observeOperatorAck(startHrtimeNs: bigint): number {
    const ms = Number(process.hrtime.bigint() - startHrtimeNs) / 1e6;
    this.operatorAck.observe(ms / 1000);
    return ms;
  }
}
