/**
 * F3c-payment · onBookingCancelled — el handler Kafka del refund AUTOMÁTICO del carpooling (ADR-014 §6/§9).
 * Verifica el FILTRO TIPADO por razón, la idempotencia (dedup por eventId + skip graceful), el manejo de los
 * casos válidos bajo at-least-once/reorden, y el poison — SIN Kafka real (espía sobre KafkaEventConsumer.on,
 * como consumers.poison.spec). La lógica de plata (refund full, payment.refunded) la cubre
 * refund-booking-cancellation.spec; acá se verifica el ENRUTADO del consumer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEnvelope, BookingCancelledRazon, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { InvalidStateError, UnprocessableEntityError } from '@veo/utils';
import { PaymentEventConsumers } from './consumers';
import type { PaymentsService } from '../payments/payments.service';
import type { PayoutsService } from '../payouts/payouts.service';
import type { CreditService } from '../credit/credit.service';
import type { IncentivesService } from '../incentives/incentives.service';

const handlers = new Map<string, EventHandler>();
vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  eventType: string,
  handler: EventHandler,
) {
  handlers.set(eventType, handler);
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = {
  getOrThrow: (k: string): string => (k === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
} as never;

const VALID_BOOKING_ID = '018f9a3e-1c2b-7d4e-8a1f-0123456789ab';

/** Redis double con dedup REAL en memoria: marca tras el éxito; un eventId ya marcado no re-ejecuta. */
function makeRedis() {
  const store = new Set<string>();
  return {
    get: vi.fn(async (k: string) => (store.has(k) ? '1' : null)),
    set: vi.fn(async (k: string) => {
      store.add(k);
      return 'OK';
    }),
  };
}

function build(
  refund: ReturnType<typeof vi.fn>,
  redis = makeRedis(),
): {
  svc: PaymentEventConsumers;
  refund: typeof refund;
  redis: typeof redis;
  incRefundBackstop: ReturnType<typeof vi.fn>;
} {
  const payments = { refundForBookingCancellation: refund } as unknown as PaymentsService;
  const payouts = { holdDriver: vi.fn(async () => {}) } as unknown as PayoutsService;
  const incentives = { creditTrip: vi.fn(async () => {}) } as unknown as IncentivesService;
  const credit = { creditFromReferral: vi.fn(async () => true) } as unknown as CreditService;
  const incRefundBackstop = vi.fn();
  const metrics = { incRefundBackstop } as unknown as import('../metrics/payment.metrics').PaymentMetrics;
  const svc = new PaymentEventConsumers(payments, payouts, incentives, credit, redis as never, metrics, config);
  return { svc, refund, redis, incRefundBackstop };
}

function fire(razon: BookingCancelledRazon | undefined, over: Record<string, unknown> = {}) {
  const env = createEnvelope({
    eventType: 'booking.cancelled',
    producer: 'booking-service',
    payload: {
      bookingId: VALID_BOOKING_ID,
      ...(razon ? { razon } : {}),
      estado: 'CANCELADO',
      estadoAnterior: 'COBRO_PENDIENTE',
      ...over,
    },
  });
  return { env, run: () => handlers.get('booking.cancelled')?.(env) };
}

beforeEach(() => handlers.clear());

describe('PaymentEventConsumers · onBookingCancelled (F3c · refund automático)', () => {
  it('ASIENTO_LLENO → llama refundForBookingCancellation(bookingId, razon)', async () => {
    const refund = vi.fn(async () => ({ refundId: 'ref-1', paymentId: 'pay-1', status: 'COMPLETED' }));
    const { svc } = build(refund);
    await svc.onModuleInit();

    await fire(BookingCancelledRazon.ASIENTO_LLENO).run();

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(VALID_BOOKING_ID, BookingCancelledRazon.ASIENTO_LLENO);
    await svc.onModuleDestroy();
  });

  it('OFERTA_NO_DISPONIBLE → también refunda', async () => {
    const refund = vi.fn(async () => ({ refundId: 'ref-1', paymentId: 'pay-1', status: 'COMPLETED' }));
    const { svc } = build(refund);
    await svc.onModuleInit();

    await fire(BookingCancelledRazon.OFERTA_NO_DISPONIBLE).run();

    expect(refund).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });

  it('COBRO_FALLIDO → NO-OP (nunca se capturó, no hay nada que devolver)', async () => {
    const refund = vi.fn();
    const { svc } = build(refund);
    await svc.onModuleInit();

    await fire(BookingCancelledRazon.COBRO_FALLIDO).run();

    expect(refund).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('COBRO_RECHAZADO → NO-OP (charge-on-approval rechazado, sin captura)', async () => {
    const refund = vi.fn();
    const { svc } = build(refund);
    await svc.onModuleInit();

    await fire(BookingCancelledRazon.COBRO_RECHAZADO, { estadoAnterior: 'APROBADO' }).run();

    expect(refund).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('cancelación de OFERTA (forma A: sin bookingId/razon) → NO-OP (no es asunto de este refund)', async () => {
    const refund = vi.fn();
    const { svc } = build(refund);
    await svc.onModuleInit();

    const env = createEnvelope({
      eventType: 'booking.cancelled',
      producer: 'booking-service',
      payload: {
        publishedTripId: VALID_BOOKING_ID,
        driverId: VALID_BOOKING_ID,
        estado: 'CANCELADO',
        estadoAnterior: 'PUBLICADO',
      },
    });
    await handlers.get('booking.cancelled')?.(env);

    expect(refund).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('IDEMPOTENCIA (dedup eventId): el MISMO evento entregado 2× → refund UNA sola vez', async () => {
    const refund = vi.fn(async () => ({ refundId: 'ref-1', paymentId: 'pay-1', status: 'COMPLETED' }));
    const { svc } = build(refund);
    await svc.onModuleInit();

    const { run } = fire(BookingCancelledRazon.ASIENTO_LLENO);
    await run();
    await run(); // re-delivery EXACTO (mismo eventId) → dedup barato lo corta.

    expect(refund).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });

  it('Payment no encontrado / ya refunded (skipped) → graceful, NO relanza', async () => {
    const refund = vi.fn(async () => ({ skipped: true, motivo: 'sin cobro reembolsable' }));
    const { svc } = build(refund);
    await svc.onModuleInit();

    await expect(fire(BookingCancelledRazon.ASIENTO_LLENO).run()).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('payload inválido → warn + return (no rompe el stream, no llama al refund)', async () => {
    const refund = vi.fn();
    const { svc } = build(refund);
    await svc.onModuleInit();

    const env = createEnvelope({
      eventType: 'booking.cancelled',
      producer: 'booking-service',
      payload: { estado: 'OTRO_ESTADO' }, // viola el literal 'CANCELADO' → safeParse falla.
    });
    await expect(handlers.get('booking.cancelled')?.(env)).resolves.toBeUndefined();

    expect(refund).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('POISON: bookingId no-UUID → log & skip (no relanza, no llama al refund)', async () => {
    const refund = vi.fn();
    const { svc } = build(refund);
    await svc.onModuleInit();

    await expect(
      fire(BookingCancelledRazon.ASIENTO_LLENO, { bookingId: 'NOT-A-UUID' }).run(),
    ).resolves.toBeUndefined();

    expect(refund).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('error TRANSITORIO (DB caída) → SÍ relanza (Kafka reintenta; dedup NO se marcó)', async () => {
    const transient = Object.assign(new Error('connection refused'), { code: 'P1001' });
    const refund = vi.fn(async () => {
      throw transient;
    });
    const { svc } = build(refund);
    await svc.onModuleInit();

    await expect(fire(BookingCancelledRazon.ASIENTO_LLENO).run()).rejects.toBe(transient);
    await svc.onModuleDestroy();
  });

  it('error PERMANENTE de datos (P2023) → NO relanza (defensa en profundidad)', async () => {
    const poison = Object.assign(new Error('inconsistent column data'), { code: 'P2023' });
    const refund = vi.fn(async () => {
      throw poison;
    });
    const { svc } = build(refund);
    await svc.onModuleInit();

    await expect(fire(BookingCancelledRazon.ASIENTO_LLENO).run()).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  // ─── F3c FIX 3 · cierre del loop de redelivery ∞ del gateway REJECTED síncrono ───────────────────────

  it('gateway REJECTED síncrono (UnprocessableEntityError) → NO relanza (no loop Kafka); la métrica la emite el service, NO el consumer', async () => {
    // El Refund quedó REJECTED PERSISTIDO en DB (rejectRefundAndCompensate corrió ANTES del throw). El consumer
    // ABSORBE: si relanzara, kafkajs no commitea el offset → re-entrega el MISMO evento ∞ (head-of-line block).
    // Se ELIMINÓ el cron re-conductor: el backstop ahora es marca durable (la fila REJECTED) + métrica + alerta.
    // La métrica `payment_refund_backstop_total{reason="rejected"}` se emite en el RIEL COMÚN
    // (rejectRefundAndCompensate, cubierto por refund-reject-backstop.spec), NO en el consumer — así el riel
    // ASÍNCRONO por callback también queda cubierto y NO hay doble conteo. Acá el consumer solo ABSORBE (no emite).
    const rejected = new UnprocessableEntityError('El proveedor rechazó el reembolso: reverse_rejected');
    const refund = vi.fn(async () => {
      throw rejected;
    });
    const { svc, incRefundBackstop } = build(refund);
    await svc.onModuleInit();

    await expect(fire(BookingCancelledRazon.ASIENTO_LLENO).run()).resolves.toBeUndefined();
    expect(refund).toHaveBeenCalledTimes(1);
    // El consumer NO emite la métrica de 'rejected' (la dueña es rejectRefundAndCompensate, riel común).
    expect(incRefundBackstop).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('gateway REJECTED re-entregado → sigue SIN relanzar (idempotente, jamás loop ∞)', async () => {
    // Aunque Kafka re-entregue el MISMO booking.cancelled (otra partición rebalance, etc.), el consumer NUNCA
    // relanza por un REJECTED: lo absorbe al backstop admin (sin reintento automático). Ambas entregas resuelven.
    const rejected = new UnprocessableEntityError('El proveedor rechazó el reembolso');
    const refund = vi.fn(async () => {
      throw rejected;
    });
    const { svc } = build(refund);
    await svc.onModuleInit();

    const { run } = fire(BookingCancelledRazon.ASIENTO_LLENO);
    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('no-recuperable sin Refund persistido (InvalidStateError: gateway sin reembolsos) → ALERTA + return, NO loop', async () => {
    // Abortó ANTES de persistir un Refund REJECTED → el cron no tiene qué retomar. Reintentar por Kafka loopearía
    // ∞ (la condición es permanente). El consumer NO relanza: surfacea para backstop admin (alerta), NO loop.
    const unrecoverable = new InvalidStateError('El gateway activo no soporta reembolsos digitales');
    const refund = vi.fn(async () => {
      throw unrecoverable;
    });
    const { svc, incRefundBackstop } = build(refund);
    await svc.onModuleInit();

    await expect(fire(BookingCancelledRazon.ASIENTO_LLENO).run()).resolves.toBeUndefined();
    // Señal observable del backstop: además del log de alerta, se incrementa la métrica scrapeable
    // payment_refund_backstop_total{reason="unrecoverable"} (sobre la que dispara la alerta de ops).
    expect(incRefundBackstop).toHaveBeenCalledWith('unrecoverable');
    await svc.onModuleDestroy();
  });
});
