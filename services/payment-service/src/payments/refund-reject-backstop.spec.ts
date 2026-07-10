/**
 * F3c-payment · INVARIANTE SAGRADO del backstop de refunds en el RIEL COMÚN de rechazo
 * (`rejectRefundAndCompensate`). El hueco que cierra: la métrica scrapeable del backstop
 * (`payment_refund_backstop_total{reason="rejected"}`, sobre la que dispara la alerta de ops) ANTES vivía SOLO
 * en el consumer Kafka (riel SÍNCRONO). El riel ASÍNCRONO la evadía: cuando el proveedor ACEPTA el reverso
 * (PENDING) y DÍAS después lo RECHAZA por callback (DECLINED/EXPIRED → applyRefundWebhookResult), el consumer
 * ya commiteó el offset (vio PENDING=éxito) → el Refund pasaba a REJECTED + el Payment volvía a CAPTURED SIN
 * métrica/alerta/rastro accionable: pasajero pagó, no viajó, reverso declinado en silencio.
 *
 * El fix mueve la emisión al ÚNICO punto donde un Refund se vuelve REJECTED (`rejectRefundAndCompensate`), que
 * alcanzan AMBOS rieles. Este spec verifica:
 *   1. ASYNC (callback DECLINED/EXPIRED, system-initiated) → emite `incRefundBackstop('rejected')` (ANTES no).
 *   2. SÍNCRONO (gateway REJECTED, system-initiated) → emite EXACTAMENTE UNA vez (sin doble conteo).
 *   3. ADMIN (dedupKey NULL) rechazado → NO emite la métrica de backstop (la ve el operador en su UI).
 *
 * Estilo del repo: dobles de Prisma a mano, sin Nest DI (como refund-booking-cancellation.spec).
 */
import { describe, it, expect, vi } from 'vitest';
import { UnprocessableEntityError } from '@veo/utils';
import { PaymentsService } from './payments.service';
import { BookingCancelledRazon } from '@veo/events';
import { deriveBookingCancellationRefundDedupKey } from './payment.policy';
import type { PaymentTx } from './payments.repository';
import type { PaymentMetrics } from '../metrics/payment.metrics';
import type { PaymentGateway, RefundResult } from '../ports/gateway/payment-gateway.port';

interface FakePayment {
  id: string;
  tripId: string;
  method: string;
  passengerId: string | null;
  status: string;
  amountCents: number;
  refundedCents: number;
  refundedAt: Date | null;
  capturedAt: Date | null;
  createdAt: Date;
  externalRef: string | null;
  externalUid: string | null;
}

interface FakeRefund {
  id: string;
  paymentId: string;
  amountCents: number;
  requestedBy: string;
  approvedBy: string | null;
  dedupKey: string | null;
  externalRefundId: string | null;
  status: string;
  reason: string;
  failureReason: string | null;
}

function capturedPayment(over: Partial<FakePayment> = {}): FakePayment {
  return {
    id: 'pay-1',
    tripId: '018f9a3e-1c2b-7d4e-8a1f-0123456789ab',
    method: 'YAPE',
    passengerId: 'pax-1',
    status: 'CAPTURED',
    amountCents: 4500,
    refundedCents: 0,
    refundedAt: null,
    capturedAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    externalRef: 'rail-uid-1',
    externalUid: null,
    ...over,
  };
}

/**
 * Repo fake (mock del SEAM PaymentsRepository) que honra el CAS del Refund (PENDING→REJECTED) y el `decrement`
 * atómico del Payment. Soporta TANTO el camino síncrono (refundForBookingCancellation → refundViaGateway) como el
 * async (applyRefundWebhookResult → findRefundByExternalRefundId → rejectRefundAndCompensate).
 */
function makeRepo(payment: FakePayment, seedRefund?: FakeRefund) {
  const refunds: FakeRefund[] = seedRefund ? [seedRefund] : [];

  const repo = {
    findRefundablePaymentByTrip: vi.fn(async (tripId: string) =>
      payment.tripId === tripId && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)
        ? payment
        : null,
    ),
    findRefundByExternalRefundId: vi.fn(
      async (uid: string) => refunds.find((r) => r.externalRefundId === uid) ?? null,
    ),
    runInTransaction: async <T>(work: (tx: PaymentTx) => Promise<T>): Promise<T> =>
      work({} as PaymentTx),
    // CAS de la RESERVA (claimRefundReservationInTx) en el camino síncrono.
    casClaimRefundReservation: vi.fn(
      async (
        _tx: PaymentTx,
        paymentId: string,
        expectedRefundedCents: number,
        data: Partial<FakePayment>,
      ) => {
        if (
          payment.id !== paymentId ||
          !['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) ||
          payment.refundedCents !== expectedRefundedCents
        ) {
          return { count: 0 };
        }
        Object.assign(payment, data);
        return { count: 1 };
      },
    ),
    createRefundInTx: vi.fn(async (_tx: PaymentTx, data: FakeRefund) => {
      refunds.push(data);
      return data;
    }),
    // Persistencia del uid del reverso (refundViaGateway, fuera de la tx de reserva).
    setRefundExternalId: vi.fn(async (refundId: string, externalRefundId: string) => {
      const r = refunds.find((x) => x.id === refundId);
      if (r) r.externalRefundId = externalRefundId;
    }),
    // CAS PENDING→REJECTED (único punto donde un Refund se vuelve REJECTED).
    casRejectRefund: vi.fn(
      async (_tx: PaymentTx, refundId: string, data: Partial<FakeRefund>) => {
        const r = refunds.find((x) => x.id === refundId && x.status === 'PENDING');
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    ),
    findRefundByIdInTx: vi.fn(async (_tx: PaymentTx, refundId: string) => {
      const r = refunds.find((x) => x.id === refundId);
      if (!r) throw new Error('refund not found');
      return { ...r };
    }),
    // Compensación: decrement atómico → devuelve el Payment con el saldo real ya restado.
    decrementPaymentRefundedInTx: vi.fn(
      async (_tx: PaymentTx, _paymentId: string, amountCents: number) => {
        payment.refundedCents -= amountCents;
        return { ...payment };
      },
    ),
    // Restauración del status del Payment tras compensar (PARTIALLY_REFUNDED|CAPTURED derivado del saldo).
    restorePaymentAfterRejectInTx: vi.fn(
      async (_tx: PaymentTx, _paymentId: string, data: { status?: string; refundedAt?: Date | null }) => {
        if (data.status !== undefined) payment.status = data.status;
        if (data.refundedAt !== undefined) payment.refundedAt = data.refundedAt;
      },
    ),
    findDriverDebtByPaymentInTx: vi.fn(async () => null),
    enqueueOutbox: vi.fn(async () => {}),
  };

  return { repo, refunds };
}

const config = { getOrThrow: () => 0 } as never;

/** Gateway double que SOPORTA reembolsos (type-guard supportsRefund) y devuelve el RefundResult dado. */
function rejectingGateway(result: RefundResult): PaymentGateway {
  return {
    chargeFlow: 'aggregator',
    supports: () => true,
    charge: vi.fn(),
    getStatement: vi.fn(async () => []),
    refund: vi.fn(async () => result),
  } as unknown as PaymentGateway;
}

function buildService(
  repo: ReturnType<typeof makeRepo>['repo'],
  gateway: PaymentGateway,
  metrics: PaymentMetrics,
) {
  // Orden del constructor: (repo, gateway, affiliations, promotions, config, credit?, metrics?).
  return new PaymentsService(repo as never, gateway, {} as never, {} as never, config, undefined, metrics);
}

const BOOKING_ID = '018f9a3e-1c2b-7d4e-8a1f-0123456789ab';

describe('rejectRefundAndCompensate · backstop del invariante sagrado (riel común síncrono + async)', () => {
  it('ASYNC (callback DECLINED, system-initiated) → emite incRefundBackstop("rejected") + Refund REJECTED durable + Payment restaurado a CAPTURED', async () => {
    // El reverso fue ACEPTADO (PENDING) y el callback lo RECHAZA días después. ESTE es el riel que ANTES evadía
    // la métrica (el consumer ya commiteó el offset al ver PENDING). Ahora la emite rejectRefundAndCompensate.
    const payment = capturedPayment({
      status: 'REFUNDED',
      refundedCents: 4500,
      refundedAt: new Date(),
    });
    const pendingRefund: FakeRefund = {
      id: 'ref-async',
      paymentId: 'pay-1',
      amountCents: 4500,
      requestedBy: 'system',
      approvedBy: 'system',
      dedupKey: deriveBookingCancellationRefundDedupKey(BOOKING_ID), // SYSTEM-INITIATED.
      externalRefundId: 'reverse-uid-async',
      status: 'PENDING',
      reason: BookingCancelledRazon.ASIENTO_LLENO,
      failureReason: null,
    };
    const { repo, refunds } = makeRepo(payment, pendingRefund);
    const incRefundBackstop = vi.fn();
    const metrics = { incRefundBackstop } as unknown as PaymentMetrics;
    const svc = buildService(repo, rejectingGateway({ status: 'PENDING' }), metrics);

    const res = await svc.applyRefundWebhookResult({
      externalRefundId: 'reverse-uid-async',
      status: 'DECLINED',
    });

    expect(res).toEqual({ applied: true, status: 'REJECTED' });
    // Métrica del backstop emitida (la regresión que cazó el gate: ANTES NO se emitía en este riel).
    expect(incRefundBackstop).toHaveBeenCalledTimes(1);
    expect(incRefundBackstop).toHaveBeenCalledWith('rejected');
    // Rastro durable: Refund REJECTED + Payment compensado a CAPTURED (la plata nunca se movió).
    expect(refunds[0]!.status).toBe('REJECTED');
    expect(payment.status).toBe('CAPTURED');
    expect(payment.refundedCents).toBe(0);
  });

  it('ASYNC EXPIRED (system-initiated) → también emite el backstop (mismo riel de rechazo)', async () => {
    const payment = capturedPayment({
      status: 'REFUNDED',
      refundedCents: 4500,
      refundedAt: new Date(),
    });
    const pendingRefund: FakeRefund = {
      id: 'ref-exp',
      paymentId: 'pay-1',
      amountCents: 4500,
      requestedBy: 'system',
      approvedBy: 'system',
      dedupKey: deriveBookingCancellationRefundDedupKey(BOOKING_ID),
      externalRefundId: 'reverse-uid-exp',
      status: 'PENDING',
      reason: BookingCancelledRazon.OFERTA_NO_DISPONIBLE,
      failureReason: null,
    };
    const { repo } = makeRepo(payment, pendingRefund);
    const incRefundBackstop = vi.fn();
    const metrics = { incRefundBackstop } as unknown as PaymentMetrics;
    const svc = buildService(repo, rejectingGateway({ status: 'PENDING' }), metrics);

    await svc.applyRefundWebhookResult({ externalRefundId: 'reverse-uid-exp', status: 'EXPIRED' });

    expect(incRefundBackstop).toHaveBeenCalledWith('rejected');
  });

  it('ASYNC re-entregado (callback DECLINED 2×, system-initiated) → métrica UNA sola vez (CAS idempotente)', async () => {
    // Una redelivery del callback NO debe volver a contar: el CAS PENDING→REJECTED ya no aplica (count=0).
    const payment = capturedPayment({
      status: 'REFUNDED',
      refundedCents: 4500,
      refundedAt: new Date(),
    });
    const pendingRefund: FakeRefund = {
      id: 'ref-redeliv',
      paymentId: 'pay-1',
      amountCents: 4500,
      requestedBy: 'system',
      approvedBy: 'system',
      dedupKey: deriveBookingCancellationRefundDedupKey(BOOKING_ID),
      externalRefundId: 'reverse-uid-redeliv',
      status: 'PENDING',
      reason: BookingCancelledRazon.ASIENTO_LLENO,
      failureReason: null,
    };
    const { repo } = makeRepo(payment, pendingRefund);
    const incRefundBackstop = vi.fn();
    const metrics = { incRefundBackstop } as unknown as PaymentMetrics;
    const svc = buildService(repo, rejectingGateway({ status: 'PENDING' }), metrics);

    await svc.applyRefundWebhookResult({
      externalRefundId: 'reverse-uid-redeliv',
      status: 'DECLINED',
    });
    await svc.applyRefundWebhookResult({
      externalRefundId: 'reverse-uid-redeliv',
      status: 'DECLINED',
    });

    expect(incRefundBackstop).toHaveBeenCalledTimes(1);
  });

  it('SÍNCRONO (gateway REJECTED, system-initiated) → emite EXACTAMENTE UNA vez (sin doble conteo con el consumer)', async () => {
    // El gateway rechaza síncrono → rejectRefundAndCompensate emite la métrica y LUEGO refundViaGateway lanza
    // UnprocessableEntityError. El consumer (que YA NO emite 'rejected') solo absorbe → conteo total = 1.
    const payment = capturedPayment();
    const { repo } = makeRepo(payment);
    const incRefundBackstop = vi.fn();
    const metrics = { incRefundBackstop } as unknown as PaymentMetrics;
    const svc = buildService(
      repo,
      rejectingGateway({ status: 'REJECTED', reason: 'reverse_rejected' }),
      metrics,
    );

    await expect(
      svc.refundForBookingCancellation(BOOKING_ID, BookingCancelledRazon.ASIENTO_LLENO),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);

    // EXACTAMENTE una emisión: la dueña es rejectRefundAndCompensate, no el consumer.
    expect(incRefundBackstop).toHaveBeenCalledTimes(1);
    expect(incRefundBackstop).toHaveBeenCalledWith('rejected');
    // Compensado: la reserva se revirtió, el Payment vuelve a CAPTURED (reembolsable por admin a mano).
    expect(payment.status).toBe('CAPTURED');
    expect(payment.refundedCents).toBe(0);
  });

  it('ADMIN rechazado (dedupKey NULL) por callback → NO emite la métrica de backstop (lo ve el operador en su UI)', async () => {
    // Un refund ADMIN discrecional lleva dedupKey NULL. Su rechazo pasa por el MISMO rejectRefundAndCompensate,
    // pero la métrica de backstop es SOLO para los system-initiated (sin humano monitoreando).
    const payment = capturedPayment({
      status: 'REFUNDED',
      refundedCents: 4500,
      refundedAt: new Date(),
    });
    const adminRefund: FakeRefund = {
      id: 'ref-admin',
      paymentId: 'pay-1',
      amountCents: 4500,
      requestedBy: 'admin-user-1',
      approvedBy: 'admin-user-1',
      dedupKey: null, // ADMIN discrecional → sin dedupKey system-initiated.
      externalRefundId: 'reverse-uid-admin',
      status: 'PENDING',
      reason: 'goodwill',
      failureReason: null,
    };
    const { repo, refunds } = makeRepo(payment, adminRefund);
    const incRefundBackstop = vi.fn();
    const metrics = { incRefundBackstop } as unknown as PaymentMetrics;
    const svc = buildService(repo, rejectingGateway({ status: 'PENDING' }), metrics);

    const res = await svc.applyRefundWebhookResult({
      externalRefundId: 'reverse-uid-admin',
      status: 'DECLINED',
    });

    expect(res).toEqual({ applied: true, status: 'REJECTED' });
    // El rechazo se procesó (Refund REJECTED + Payment restaurado) pero SIN métrica de backstop.
    expect(refunds[0]!.status).toBe('REJECTED');
    expect(payment.status).toBe('CAPTURED');
    expect(incRefundBackstop).not.toHaveBeenCalled();
  });
});
