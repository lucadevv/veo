/**
 * F3c-payment · refundForBookingCancellation (refund AUTOMÁTICO system-initiated por `booking.cancelled`).
 * El ÚLTIMO eslabón del marketplace de carpooling (ADR-014 §6/§9): el cobro CAPTURÓ pero el booking se canceló
 * (asiento lleno / oferta no reservable) → el pasajero no viajó → se le devuelve TODO, sin operador.
 *
 * Estilo del repo: dobles de Prisma construidos a mano, sin Nest DI (como payouts.release.spec / consumers.poison.spec).
 * Camino CASH (devolución local, sin gateway) — ejercita el CORE compartido del refund y, crucialmente, la
 * IDEMPOTENCIA: el `Refund.dedupKey` UNIQUE garantiza que un `booking.cancelled` duplicado NO devuelve la plata
 * dos veces (P2002 → no-op graceful). El refund ADMIN existente reusa el MISMO core y NO se rompe (su spec aparte).
 *
 * NO SKILL NestJS: no había una skill de NestJS en el registro; se siguió el patrón REAL del repo como plantilla.
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../generated/prisma';
import { PaymentsService, SYSTEM_OPERATOR } from './payments.service';
import { BookingCancelledRazon } from '@veo/events';
import { deriveBookingCancellationRefundDedupKey } from './payment.policy';
import type { PrismaService } from '../infra/prisma.service';

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
  status: string;
  reason: string;
}

type OutboxRow = { aggregateId: string; eventType: string; envelope: { payload: Record<string, unknown> } };

// P2002 (unique violation) con la shape que `isUniqueViolation` reconoce (name + code + meta.target).
function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: [target] },
  });
}

function capturedPayment(over: Partial<FakePayment> = {}): FakePayment {
  return {
    id: 'pay-1',
    tripId: 'bkg-1',
    method: 'CASH',
    passengerId: 'pax-1',
    status: 'CAPTURED',
    amountCents: 4500,
    refundedCents: 0,
    refundedAt: null,
    capturedAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    externalRef: null,
    externalUid: null,
    ...over,
  };
}

/**
 * Prisma double en memoria que HONRA el UNIQUE de `refund.dedupKey` (clave de la idempotencia): un 2do create
 * con un dedupKey ya usado lanza P2002. Y el CAS de `claimRefundReservationInTx` (updateMany condicionado por
 * status + refundedCents) afecta filas solo si el estado/saldo no cambió.
 */
function makePrisma(payment: FakePayment | null) {
  const refunds: FakeRefund[] = [];
  const outbox: OutboxRow[] = [];
  const usedDedupKeys = new Set<string>();

  const tx = {
    payment: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: { in: string[] }; refundedCents: number };
          data: Partial<FakePayment>;
        }) => {
          if (
            !payment ||
            payment.id !== where.id ||
            !where.status.in.includes(payment.status) ||
            payment.refundedCents !== where.refundedCents
          ) {
            return { count: 0 };
          }
          Object.assign(payment, data);
          return { count: 1 };
        },
      ),
    },
    refund: {
      create: vi.fn(async ({ data }: { data: FakeRefund }) => {
        if (data.dedupKey) {
          if (usedDedupKeys.has(data.dedupKey)) throw uniqueViolation('dedup_key');
          usedDedupKeys.add(data.dedupKey);
        }
        refunds.push(data);
        return data;
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: OutboxRow }) => {
        outbox.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    read: {
      payment: {
        findFirst: vi.fn(async ({ where }: { where: { tripId: string; status: { in: string[] } } }) =>
          payment && payment.tripId === where.tripId && where.status.in.includes(payment.status)
            ? payment
            : null,
        ),
      },
    },
    write: {
      $transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    },
  } as unknown as PrismaService;

  return { prisma, refunds, outbox, txRefundCreate: tx.refund.create };
}

// El constructor solo lee números de config; el camino CASH no toca gateway/affiliations/promotions/credit.
const config = { getOrThrow: () => 0 } as never;
function buildService(prisma: PrismaService): PaymentsService {
  return new PaymentsService(prisma, {} as never, {} as never, {} as never, config);
}

const REASON_FULL = BookingCancelledRazon.ASIENTO_LLENO;

describe('PaymentsService.refundForBookingCancellation (F3c · refund automático system-initiated)', () => {
  it('ASIENTO_LLENO → refund FULL del saldo, Refund system-initiated y payment.refunded con passengerId', async () => {
    const payment = capturedPayment({ amountCents: 4500, passengerId: 'pax-1' });
    const { prisma, refunds, outbox } = makePrisma(payment);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);

    expect('skipped' in res).toBe(false);
    // FULL: devuelve TODO el saldo (4500) → Payment queda REFUNDED.
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amountCents: 4500,
      requestedBy: SYSTEM_OPERATOR,
      approvedBy: SYSTEM_OPERATOR,
      dedupKey: deriveBookingCancellationRefundDedupKey('bkg-1'),
      status: 'COMPLETED',
    });
    expect(payment.status).toBe('REFUNDED');
    expect(payment.refundedCents).toBe(4500);
    // payment.refunded en la MISMA tx (outbox), con el passengerId del Payment (para el push) y approvedBy=system.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('payment.refunded');
    expect(outbox[0]!.envelope.payload).toMatchObject({
      paymentId: 'pay-1',
      tripId: 'bkg-1',
      amountCents: 4500,
      approvedBy: SYSTEM_OPERATOR,
      passengerId: 'pax-1',
    });
  });

  it('OFERTA_NO_DISPONIBLE → también refunda (hubo captura)', async () => {
    const payment = capturedPayment();
    const { prisma, refunds } = makePrisma(payment);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-1', BookingCancelledRazon.OFERTA_NO_DISPONIBLE);

    expect('skipped' in res).toBe(false);
    expect(refunds).toHaveLength(1);
    expect(payment.status).toBe('REFUNDED');
  });

  it('refund FULL sobre un PARCIAL previo: devuelve solo el saldo restante', async () => {
    // Ya se reembolsó 1000 de 4500 (admin parcial) → el system-initiated devuelve los 3500 restantes.
    const payment = capturedPayment({ status: 'PARTIALLY_REFUNDED', refundedCents: 1000 });
    const { prisma, refunds } = makePrisma(payment);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);

    expect('skipped' in res).toBe(false);
    expect(refunds[0]!.amountCents).toBe(3500);
    expect(payment.status).toBe('REFUNDED');
    expect(payment.refundedCents).toBe(4500);
  });

  it('IDEMPOTENCIA (lo crítico): evento DUPLICADO → UN solo refund, UN solo payment.refunded', async () => {
    const payment = capturedPayment();
    const { prisma, refunds, outbox } = makePrisma(payment);
    const svc = buildService(prisma);

    const first = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);
    // 2da entrega del MISMO booking.cancelled: el Payment ya está REFUNDED → findFirst no lo encuentra →
    // skip graceful (sin tocar el dedupKey). Plata devuelta UNA sola vez.
    const second = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);

    expect('skipped' in first).toBe(false);
    expect('skipped' in second).toBe(true);
    expect(refunds).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('IDEMPOTENCIA (reorden duro): si el Payment SIGUE reembolsable pero el dedupKey ya existe → P2002 → skip', async () => {
    // Fuerza el caso adverso: el lookup encuentra el Payment todavía reembolsable (CAPTURED) pero el refund de
    // ESTA cancelación YA fue creado antes → el create choca contra el UNIQUE → no-op graceful, NO doble plata.
    const payment = capturedPayment();
    const { prisma, refunds, txRefundCreate } = makePrisma(payment);
    // Simula que ya existía el refund: marca el dedupKey como usado pre-poblando un create previo.
    await txRefundCreate({
      data: {
        id: 'pre',
        paymentId: 'pay-1',
        amountCents: 1,
        requestedBy: SYSTEM_OPERATOR,
        approvedBy: SYSTEM_OPERATOR,
        dedupKey: deriveBookingCancellationRefundDedupKey('bkg-1'),
        status: 'COMPLETED',
        reason: 'x',
      },
    } as never);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);

    expect('skipped' in res).toBe(true);
    // Solo el refund pre-poblado; el 2do intento NO creó otro (chocó contra el UNIQUE).
    expect(refunds).toHaveLength(1);
  });

  it('Payment no encontrado (cobro no capturó / ya refunded / evento adelantado) → skipped, sin error', async () => {
    const { prisma, refunds } = makePrisma(null);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-404', REASON_FULL);

    expect(res).toMatchObject({ skipped: true });
    expect(refunds).toHaveLength(0);
  });

  it('Payment ya totalmente REFUNDED (saldo 0) → skipped graceful (no-op)', async () => {
    // status CAPTURED pero sin saldo (caso defensivo): remaining<=0 → skip, sin crear refund.
    const payment = capturedPayment({ refundedCents: 4500 });
    const { prisma, refunds } = makePrisma(payment);
    const svc = buildService(prisma);

    const res = await svc.refundForBookingCancellation('bkg-1', REASON_FULL);

    expect(res).toMatchObject({ skipped: true });
    expect(refunds).toHaveLength(0);
  });
});
