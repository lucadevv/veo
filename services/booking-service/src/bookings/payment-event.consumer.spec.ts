/**
 * F3c · tests de LÓGICA del consumer de cobro async + la orquestación del seat-lock (BookingsService).
 *
 * ALCANCE Y JERARQUÍA DE EVIDENCIA (honesta): estos tests verifican la LÓGICA con un repo fake — la decisión
 * willRetry, la idempotencia por estado (NOOP cuando ya no está en COBRO_PENDIENTE), el ruteo del outcome del
 * seat-lock, el dedup por eventId del consumer, y el descarte de payloads inválidos. NO verifican el LOCK
 * PESIMISTA REAL (`SELECT ... FOR UPDATE`) — un lock NO se prueba con mocks. La verificación del anti-oversold
 * concurrente vive en el test e2e con Postgres REAL (testcontainers): `test/seat-lock-concurrency.e2e.spec.ts`.
 *
 * Estilo: espeja bookings.service.spec.ts (clases construidas directo, sin Nest DI, repo fake con vi.fn).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEnvelope, type EventEnvelope } from '@veo/events';
import { BookingState } from '../generated/prisma';
import { BookingsService } from './bookings.service';
import type { BookingsRepository, ConfirmSeatOutcome } from './bookings.repository';
import { BookingPaymentConsumer } from './payment-event.consumer';
import type { IdentityClient } from '../identity/identity-client.port';
import type { PaymentGateway } from '../ports/payment/payment-gateway.port';
import type { CostCapService } from '../cost-cap/cost-cap.service';

const BOOKING_ID = '0192f8a0-0000-7000-8000-0000000000b1';
const PAYMENT_ID = '0192f8a0-0000-7000-8000-0000000000f1';
const TRIP_ID = '0192f8a0-0000-7000-8000-0000000000a1';
const PASSENGER_ID = '0192f8a0-0000-7000-8000-0000000000c1';

/** Booking en COBRO_PENDIENTE (el estado del que parten captura/fallo). Override para los casos idempotentes. */
function makeBooking(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: BOOKING_ID,
    publishedTripId: TRIP_ID,
    passengerId: PASSENGER_ID,
    asientos: 1,
    precioAcordado: 4500,
    paymentId: PAYMENT_ID,
    estado: BookingState.COBRO_PENDIENTE,
    ...over,
  };
}

/** Repo fake: solo los métodos del path F3c (captura/fallo). El service no toca el resto en estos flujos. */
function makeRepo(
  over: Partial<{
    booking: ReturnType<typeof makeBooking> | null;
    confirmOutcome: ConfirmSeatOutcome;
    cancelFailed: unknown;
  }> = {},
) {
  const findByIdForCaptureHandler = vi.fn(async () =>
    over.booking === undefined ? makeBooking() : over.booking,
  );
  const confirmAndLockSeats = vi.fn(
    async (_booking: unknown, _paymentId: string): Promise<ConfirmSeatOutcome> =>
      over.confirmOutcome ?? { kind: 'CONFIRMED', booking: makeBooking({ estado: BookingState.CONFIRMADO }) as never, tripQuedoLleno: false },
  );
  const cancelForPaymentFailed = vi.fn(async (_bookingId: string) =>
    over.cancelFailed === undefined ? makeBooking({ estado: BookingState.CANCELADO }) : over.cancelFailed,
  );
  const repo = {
    findByIdForCaptureHandler,
    confirmAndLockSeats,
    cancelForPaymentFailed,
  } as unknown as BookingsRepository;
  return { repo, findByIdForCaptureHandler, confirmAndLockSeats, cancelForPaymentFailed };
}

function makeService(repo: BookingsRepository): BookingsService {
  // El path F3c NO usa el gateway, identity ni el cost-cap (reacciona a eventos, no llama afuera): stubs vacíos.
  const payment = {} as unknown as PaymentGateway;
  const identity = {} as unknown as IdentityClient;
  const costCap = {} as unknown as CostCapService;
  return new BookingsService(repo, payment, identity, costCap);
}

describe('BookingsService.confirmCapture · seat-lock orquestación (§6)', () => {
  it('happy: booking en COBRO_PENDIENTE → corre confirmAndLockSeats (CONFIRMADO + decremento)', async () => {
    const { repo, confirmAndLockSeats } = makeRepo({
      confirmOutcome: { kind: 'CONFIRMED', booking: makeBooking({ estado: BookingState.CONFIRMADO }) as never, tripQuedoLleno: true },
    });
    await makeService(repo).confirmCapture(BOOKING_ID, PAYMENT_ID);
    // El seat-lock SE INVOCA con el booking leído y el paymentId capturado (la txn atómica vive en el repo/DB real).
    expect(confirmAndLockSeats).toHaveBeenCalledOnce();
    const call = confirmAndLockSeats.mock.calls[0];
    if (!call) throw new Error('confirmAndLockSeats no fue llamado');
    expect(call[1]).toBe(PAYMENT_ID);
  });

  it('asiento-lleno: outcome SEAT_FULL → no lanza (booking.cancelled ASIENTO_LLENO ya lo emitió el repo)', async () => {
    const { repo, confirmAndLockSeats } = makeRepo({
      confirmOutcome: { kind: 'SEAT_FULL', booking: makeBooking({ estado: BookingState.CANCELADO }) as never },
    });
    await expect(makeService(repo).confirmCapture(BOOKING_ID, PAYMENT_ID)).resolves.toBeUndefined();
    expect(confirmAndLockSeats).toHaveBeenCalledOnce();
  });

  it('DUPLICADO (idempotente): booking ya CONFIRMADO → NO corre el seat-lock (no doble-decremento)', async () => {
    const { repo, confirmAndLockSeats } = makeRepo({
      booking: makeBooking({ estado: BookingState.CONFIRMADO }),
    });
    await makeService(repo).confirmCapture(BOOKING_ID, PAYMENT_ID);
    // El precheck corta ANTES de abrir la txn: el booking ya no está en COBRO_PENDIENTE → no-op.
    expect(confirmAndLockSeats).not.toHaveBeenCalled();
  });

  it('booking inexistente (tripId opaco no correlaciona): no-op, no corre el seat-lock', async () => {
    const { repo, confirmAndLockSeats } = makeRepo({ booking: null });
    await makeService(repo).confirmCapture(BOOKING_ID, PAYMENT_ID);
    expect(confirmAndLockSeats).not.toHaveBeenCalled();
  });

  it('NOOP del seat-lock (carrera con el where atómico): no lanza', async () => {
    const { repo } = makeRepo({ confirmOutcome: { kind: 'NOOP' } });
    await expect(makeService(repo).confirmCapture(BOOKING_ID, PAYMENT_ID)).resolves.toBeUndefined();
  });
});

describe('BookingsService.handlePaymentFailed · BR-P02 (§5.4)', () => {
  it('willRetry=true: NO-OP (payment reintenta; el booking sigue COBRO_PENDIENTE)', async () => {
    const { repo, cancelForPaymentFailed } = makeRepo();
    await makeService(repo).handlePaymentFailed(BOOKING_ID, true);
    expect(cancelForPaymentFailed).not.toHaveBeenCalled();
  });

  it('willRetry=false: CANCELADO (razon=COBRO_FALLIDO, sin Refund, sin tocar el asiento)', async () => {
    const { repo, cancelForPaymentFailed } = makeRepo();
    await makeService(repo).handlePaymentFailed(BOOKING_ID, false);
    expect(cancelForPaymentFailed).toHaveBeenCalledOnce();
    expect(cancelForPaymentFailed.mock.calls[0]?.[0]).toBe(BOOKING_ID);
  });

  it('willRetry=false DUPLICADO (ya cancelado): repo devuelve null → no-op idempotente, no lanza', async () => {
    const { repo, cancelForPaymentFailed } = makeRepo({ cancelFailed: null });
    await expect(makeService(repo).handlePaymentFailed(BOOKING_ID, false)).resolves.toBeUndefined();
    expect(cancelForPaymentFailed).toHaveBeenCalledOnce();
  });
});

/** Redis fake con la semántica de processEventOnce: get/set; marca tras el éxito. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    store,
  };
}

function capturedEnvelope(over: Partial<{ tripId: string; paymentId: string }> = {}): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'payment.captured',
    producer: 'payment-service',
    payload: {
      paymentId: over.paymentId ?? PAYMENT_ID,
      tripId: over.tripId ?? BOOKING_ID, // tripId = bookingId (opaco · §5.5)
      method: 'YAPE',
      grossCents: 4500,
      commissionCents: 900,
      passengerId: PASSENGER_ID,
    },
  });
}

function failedEnvelope(willRetry: boolean): EventEnvelope<unknown> {
  return createEnvelope({
    eventType: 'payment.failed',
    producer: 'payment-service',
    payload: { paymentId: PAYMENT_ID, tripId: BOOKING_ID, reason: 'rail_timeout', willRetry },
  });
}

/** Construye el consumer con un BookingsService stub (espiamos confirmCapture/handlePaymentFailed). */
function makeConsumer() {
  const bookings = {
    confirmCapture: vi.fn(async () => undefined),
    handlePaymentFailed: vi.fn(async () => undefined),
  } as unknown as BookingsService;
  const redis = makeRedis();
  const config = { getOrThrow: () => 'localhost:9094' } as never;
  const consumer = new BookingPaymentConsumer(bookings, redis as never, config);
  // Acceso a los handlers privados vía el record que registra handlers() (el único punto de registro).
  const handlers = (consumer as unknown as {
    handlers(): Record<string, (e: EventEnvelope<unknown>) => Promise<void>>;
  }).handlers();
  return { consumer, bookings, redis, handlers };
}

describe('BookingPaymentConsumer · dedup + validación + correlación (§7.1.bis)', () => {
  let ctx: ReturnType<typeof makeConsumer>;
  beforeEach(() => {
    ctx = makeConsumer();
  });

  it('payment.captured válido → confirmCapture(tripId=bookingId, paymentId) UNA vez', async () => {
    await ctx.handlers['payment.captured']?.(capturedEnvelope());
    expect(ctx.bookings.confirmCapture).toHaveBeenCalledOnce();
    expect((ctx.bookings.confirmCapture as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([BOOKING_ID, PAYMENT_ID]);
  });

  it('payment.captured DUPLICADO (mismo eventId) → dedup: el handler corre UNA sola vez', async () => {
    const env = capturedEnvelope();
    await ctx.handlers['payment.captured']?.(env);
    await ctx.handlers['payment.captured']?.(env); // mismo envelope = mismo eventId → fast-path dedup
    expect(ctx.bookings.confirmCapture).toHaveBeenCalledOnce();
  });

  it('payment.captured con payload INVÁLIDO → warn + return (no rompe el stream, no llama al service)', async () => {
    const bad = { ...capturedEnvelope(), payload: { tripId: 123 } } as EventEnvelope<unknown>;
    await expect(ctx.handlers['payment.captured']?.(bad)).resolves.toBeUndefined();
    expect(ctx.bookings.confirmCapture).not.toHaveBeenCalled();
  });

  it('si el handler del service LANZA → se relanza (kafkajs reintenta) y el dedup NO se marca', async () => {
    (ctx.bookings.confirmCapture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const env = capturedEnvelope();
    await expect(ctx.handlers['payment.captured']?.(env)).rejects.toThrow('db down');
    // El dedup NO se marcó (set no se llamó tras el fallo) → el reintento de kafkajs re-procesará.
    expect(ctx.redis.set).not.toHaveBeenCalled();
  });

  it('payment.failed willRetry=true → handlePaymentFailed(_, true)', async () => {
    await ctx.handlers['payment.failed']?.(failedEnvelope(true));
    expect(ctx.bookings.handlePaymentFailed).toHaveBeenCalledWith(BOOKING_ID, true);
  });

  it('payment.failed willRetry=false → handlePaymentFailed(_, false)', async () => {
    await ctx.handlers['payment.failed']?.(failedEnvelope(false));
    expect(ctx.bookings.handlePaymentFailed).toHaveBeenCalledWith(BOOKING_ID, false);
  });

  it('un groupId = UN consumer con AMBOS eventos (regla de oro): handlers() registra captured + failed', () => {
    expect(Object.keys(ctx.handlers).sort()).toEqual(['payment.captured', 'payment.failed']);
  });
});
