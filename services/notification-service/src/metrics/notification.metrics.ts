/**
 * Métricas Prometheus propias de notification (FOUNDATION §5). Se registran en el registry compartido
 * de @veo/observability (lo expone GET /metrics).
 *
 * `notification_failed_total`: una notificación que falló de forma PERMANENTE — destino muerto (token
 * inválido, no se reintenta) o reintentos AGOTADOS. Hasta ahora el fallo solo quedaba en un `logger.warn`
 * → invisible para Grafana/alertas: un push CRÍTICO (pánico, SLA p99<3s) podía morir en silencio. Esta
 * métrica lo hace VISIBLE: una alerta dispara sobre `notification_failed_total{priority="critical"}`.
 * El evento Kafka `notification.failed` queda para consumidores externos futuros; esto es la
 * observabilidad in-process inmediata (la fuente, sin round-trip por el broker).
 *
 * Label `kind` BOUNDED (no el `reason` crudo del proveedor — texto libre = explosión de cardinalidad
 * de series Prometheus). Label `priority` mapeado a {critical|normal|bulk} (no el número crudo).
 *
 * Mismo patrón que trip-service/src/trips/trip-metrics.ts y panic-service/src/metrics/panic.metrics.ts:
 * notification-service NO declara `prom-client` como dep directa. Reusamos la MISMA instancia del módulo
 * prom-client que ya usa @veo/observability, tomando la clase Counter de una métrica existente
 * (domainEventsTotal). Módulo-level (sin DI) para que bumpee igual en tests y en producción.
 */
import { domainEventsTotal, metricsRegistry } from '@veo/observability';
import type { NotificationChannel } from '@veo/shared-types';
import { NotificationPriority } from '../engine/types';

/**
 * Tipo de fallo BOUNDED (label de baja cardinalidad). NO confundir con el `reason` crudo del proveedor
 * (que sí va al log + DB + payload del evento, pero NUNCA como label de métrica).
 */
export const NotificationFailureKind = {
  /** Destino muerto (token inválido): permanente, no se reintenta. */
  InvalidRecipient: 'invalid_recipient',
  /** Agotó los reintentos (transitorio/rate-limit que no se recuperó). */
  RetryExhausted: 'retry_exhausted',
} as const;
export type NotificationFailureKind =
  (typeof NotificationFailureKind)[keyof typeof NotificationFailureKind];

/** Labels del fallo de notificación. Todos BOUNDED (canal × kind × prioridad = pocas series). */
export interface NotificationFailedLabels extends Record<string, string> {
  /** Riel del envío: PUSH | SMS | EMAIL | WEBHOOK. */
  channel: NotificationChannel;
  /** Naturaleza del fallo (bounded). */
  kind: NotificationFailureKind;
  /** Prioridad mapeada: 'critical' | 'normal' | 'bulk' — el label que habilita alertar sobre pánico. */
  priority: string;
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

export const NOTIFICATION_FAILED_METRIC = 'notification_failed_total';

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

/** Counter de fallos permanentes de notificación. Exportado para que los specs lean su valor. */
export const notificationFailedTotal: CounterLike = getOrCreateCounter(
  NOTIFICATION_FAILED_METRIC,
  'Notificaciones que fallaron permanentemente (destino muerto o reintentos agotados); priority=critical → alerta de seguridad',
  ['channel', 'kind', 'priority'],
);

/** Mapea la prioridad numérica del record a un label BOUNDED (sin números mágicos: usa NotificationPriority). */
export function priorityLabel(priority: number): string {
  switch (priority) {
    case NotificationPriority.Critical:
      return 'critical';
    case NotificationPriority.Bulk:
      return 'bulk';
    default:
      return 'normal';
  }
}

/** Bumpea el counter de fallo (al lado del warn estructurado = fallo VISIBLE, no silencioso). */
export function bumpNotificationFailed(labels: NotificationFailedLabels): void {
  notificationFailedTotal.inc(labels);
}

/** Alcance de un marcado de leído (bounded: una sola o toda la bandeja). */
export const InboxReadScope = { Single: 'single', All: 'all' } as const;
export type InboxReadScope = (typeof InboxReadScope)[keyof typeof InboxReadScope];

export const NOTIFICATION_INBOX_READ_METRIC = 'notification_inbox_read_total';

/**
 * Counter de notificaciones marcadas como leídas por el usuario (observabilidad §6 de los endpoints
 * PATCH /read y /read-all). Label `scope` BOUNDED (single|all). El valor `.inc(count)` de read-all
 * refleja cuántas se marcaron de una.
 */
export const notificationInboxReadTotal: CounterLike = getOrCreateCounter(
  NOTIFICATION_INBOX_READ_METRIC,
  'Notificaciones in-app marcadas como leídas por el destinatario (scope=single|all)',
  ['scope'],
);

/** Suma al counter de leídas. `count` = cuántas (1 para single; N para read-all). */
export function bumpInboxRead(scope: InboxReadScope, count = 1): void {
  if (count > 0) notificationInboxReadTotal.inc({ scope }, count);
}
