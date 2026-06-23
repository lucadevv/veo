/**
 * Observabilidad de los eventos de dominio que fleet-service EMITE por outbox (FOUNDATION §5/§6,
 * CLAUDE.md regla 6). El sweeper de vencimientos (expiry.sweeper) emite 4+ tipos de evento de dominio
 * (document_expiring/expired, driver_suspended/reactivated, vehicle_suspended) y hasta ahora solo logueaba
 * el RESUMEN: la emisión por TIPO era invisible para Ops. Este helper bumpea el counter ESTÁNDAR del repo
 * `domain_events_total{event,result}` (definido en @veo/observability, expuesto por GET /metrics) en el
 * MISMO punto donde se encola el evento al outbox — así "se suspendió/reactivó a N conductores hoy" es una
 * señal alertable, no un texto de log.
 *
 * Mismo patrón que trip-metrics.ts: reusamos el counter ya registrado en el registry compartido (no creamos
 * uno nuevo ni declaramos prom-client como dep directa). Es módulo-level (sin DI) para que bumpee igual en
 * producción y en los tests que construyen el sweeper sin el contenedor Nest.
 */
import { domainEventsTotal } from '@veo/observability';
import { FleetEventType } from './fleet-events';

/** Resultado de la EMISIÓN del evento de dominio (label BOUNDED del counter estándar). */
export type DomainEventResult = 'emitted';

/**
 * Bumpea `domain_events_total{event,result}` por un evento de dominio que fleet acaba de encolar al outbox.
 * El `event` es el eventType tipado del contrato (cero strings mágicos). Acompaña al `enqueue` del outbox:
 * encolar + contar van juntos (la métrica refleja la INTENCIÓN de publicar; el relay del outbox la entrega).
 */
export function recordFleetDomainEvent(
  event: FleetEventType,
  result: DomainEventResult = 'emitted',
): void {
  domainEventsTotal.inc({ event, result });
}
