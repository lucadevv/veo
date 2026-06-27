/**
 * Métricas Prometheus propias del payment-service (FOUNDATION §5 · observabilidad antes de features).
 *
 * El INVARIANTE SAGRADO de los refunds: un pasajero que pagó y no viajó NUNCA debe quedar sin refund Y sin
 * una traza observable/accionable. El backstop manual (refund admin) solo es ÚTIL si es VISIBLE: un
 * `logger.error` se pierde si nadie lo grepea. Esta métrica convierte "cayó al backstop" en una SEÑAL
 * scrapeable (Prometheus) sobre la que se dispara una alerta — el ops sabe que hay un pasajero por atender.
 *
 * Nota (igual que panic-service): payment-service no declara `prom-client` como dependencia directa. Para
 * crear contadores propios reutilizamos la MISMA instancia del módulo prom-client que ya usa
 * @veo/observability, obteniendo la clase Counter desde una métrica existente (domainEventsTotal, que ES un
 * Counter). Así el contador queda registrado en el registry correcto sin acoplar una dependencia nueva.
 */
import { Injectable } from '@nestjs/common';
import { metricsRegistry, domainEventsTotal } from '@veo/observability';

interface CounterLike {
  inc(labels: Record<string, string>): void;
}
type CounterCtor = new (cfg: {
  name: string;
  help: string;
  labelNames: readonly string[];
  registers: unknown[];
}) => CounterLike;

// Clase Counter tomada de la instancia existente (misma copia de prom-client).
const CounterClass = (domainEventsTotal as unknown as { constructor: CounterCtor }).constructor;

function getOrCreateCounter(name: string, help: string, labelNames: readonly string[]): CounterLike {
  const existing = metricsRegistry.getSingleMetric(name) as CounterLike | undefined;
  if (existing) return existing;
  return new CounterClass({ name, help, labelNames, registers: [metricsRegistry] });
}

@Injectable()
export class PaymentMetrics {
  /**
   * Refunds SYSTEM-INITIATED (refund automático por `booking.cancelled`) que cayeron al backstop manual: el
   * refund automático NO se pudo devolver solo y requiere un refund admin a mano (se ELIMINÓ el cron
   * re-conductor automático). TODO refund REJECTED persistente deja una fila durable + esta métrica + alerta.
   * Por `reason`:
   *  - `rejected`: el reverso quedó REJECTED + Payment compensado a CAPTURED. La emite `rejectRefundAndCompensate`
   *    (riel COMÚN de transición a REJECTED), así cubre AMBOS rieles: el SÍNCRONO (gateway rechaza inmediato) y el
   *    ASÍNCRONO (callback DECLINED/EXPIRED días después · applyRefundWebhookResult), que el consumer Kafka NO ve
   *    (ya commiteó el offset al ver PENDING). Solo para refunds SYSTEM-INITIATED. Sin reintento automático.
   *  - `unrecoverable`: abortó ANTES de llamar al riel (gateway sin reembolsos / cobro sin railRef); el marcador
   *    durable (Refund REJECTED de marca con failureReason 'unrecoverable:') ya lo dejó refundViaGateway.
   */
  private readonly refundBackstop: CounterLike = getOrCreateCounter(
    'payment_refund_backstop_total',
    'Refunds system-initiated que cayeron al backstop manual (sin recuperación automática), por razón',
    ['reason'] as const,
  );

  /** Incrementa el contador del backstop manual de refunds, etiquetado por la razón de la caída. */
  incRefundBackstop(reason: 'rejected' | 'unrecoverable'): void {
    this.refundBackstop.inc({ reason });
  }

  /**
   * Contador del carril money-OUT del DESEMBOLSO (ADR-015 · CLAUDE §6 "observabilidad antes de features").
   * El carril de la plata SALIENDO no emitía NINGUNA métrica: un PROCESSING que se atasca, un FAILED que el
   * operador no ve, un reintento que se dispara — todo era invisible salvo en un log que nadie grepea. Esta
   * métrica convierte cada evento money-OUT en una SEÑAL scrapeable (Prometheus) sobre la que alertar.
   * Espejo EXACTO del `payment_refund_backstop_total` del money-IN (misma instancia prom-client, mismo registry).
   * Por `event`:
   *  - `dispatched`: un payout entró a PROCESSING (disburse aceptado: SUBMITTED async o CONFIRMED síncrono).
   *  - `processed`:  un payout se confirmó (PROCESSING→PROCESSED): la plata SALIÓ de verdad.
   *  - `failed`:     el riel rechazó (PROCESSING→FAILED): la plata NO salió.
   *  - `retried`:    el operador reintentó un payout FALLIDO (FAILED→PROCESSING).
   */
  private readonly payoutDisbursement: CounterLike = getOrCreateCounter(
    'payout_disbursement_total',
    'Eventos del carril money-OUT del desembolso (ADR-015), por tipo de evento',
    ['event'] as const,
  );

  /** Incrementa el contador del carril money-OUT, etiquetado por el evento del desembolso. */
  incPayoutDisbursement(event: 'dispatched' | 'processed' | 'failed' | 'retried'): void {
    this.payoutDisbursement.inc({ event });
  }
}

/**
 * F2.7 · degradación de la comisión ON_DEMAND a la tasa del env (`COMMISSION_RATE`). Cuando `commission_config`
 * está caído/sin migrar, el cobro on-demand se liquida con la tasa del ENV, que puede DIVERGIR de la que el
 * admin configuró → impacto DIRECTO en plata (sub/sobre-comisión silenciosa). Un valor SOSTENIDO distingue una
 * config ROTA (mal deploy/migración) de un blip transitorio de DB → señal scrapeable para alertar. Módulo-level
 * (sin DI): CommissionService lo llama directo, igual que el patrón de trip-metrics, sin tocar su constructor.
 */
const commissionDegradedTotal: CounterLike = getOrCreateCounter(
  'payment_commission_degraded_total',
  'Veces que el cobro on-demand cayó a la tasa de comisión del env (commission_config no disponible). ' +
    'Valor SOSTENIDO = config rota, no un blip transitorio.',
  [] as const,
);

/** Bumpea el contador de degradación de la comisión on-demand (+ el caller logea = observabilidad completa). */
export function bumpCommissionDegraded(): void {
  commissionDegradedTotal.inc({});
}
