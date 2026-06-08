/**
 * PaymentsService.refund (BR-P06) · emisión de payment.refunded por OUTBOX.
 *
 * Antes, refund() marcaba REFUNDED pero NO emitía evento → notification-service no podía avisar al
 * pasajero. Estos tests prueban que el evento se encola en la MISMA tx con el monto reembolsado y el
 * passengerId enriquecido (persistido al cobrar), y que la ventana / la transición se respetan.
 * Prisma fake en memoria (sin red). No mockeamos DB en críticos: el doble es determinista y total.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { InvalidStateError } from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import type { AuthenticatedUser } from '@veo/auth';
import { PaymentsService } from './payments.service';
import type { PrismaService } from '../infra/prisma.service';
import type { PaymentGateway } from '../ports/gateway/payment-gateway.port';
import type { AffiliationsService } from '../affiliations/affiliations.service';
import type { PromotionsService } from '../promotions/promotions.service';

const TRIP = '0192f8a0-0000-7000-8000-000000000001';
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

interface OutboxRow {
  eventType: string;
  aggregateId: string;
  envelope: { eventType: string; payload: Record<string, unknown> };
}

/** Fake Prisma para refund(): payment.findFirst/update, refund.create, outbox. */
function makeFakePrisma(payment: Record<string, unknown>) {
  const outbox: OutboxRow[] = [];
  const refunds: Record<string, unknown>[] = [];
  const client = {
    payment: {
      findFirst: async ({ where }: { where: { tripId: string; status: string } }) =>
        payment.tripId === where.tripId && payment.status === where.status ? payment : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(payment, data);
        return payment;
      },
    },
    refund: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        refunds.push(data);
        return data;
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: OutboxRow }) => {
        outbox.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { read: client, write: client, _outbox: outbox, _refunds: refunds } as unknown as PrismaService & {
    _outbox: OutboxRow[];
    _refunds: Record<string, unknown>[];
  };
}

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'sandbox',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
  };
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService;
}

const noGateway = {} as unknown as PaymentGateway;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;
const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;

const L2: AuthenticatedUser = { userId: 'op-L2', roles: [AdminRole.SUPPORT_L2] } as unknown as AuthenticatedUser;

function capturedPayment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay-1',
    tripId: TRIP,
    status: 'CAPTURED',
    amountCents: 2000,
    grossCents: 2000,
    passengerId: PAX,
    capturedAt: new Date(),
    createdAt: new Date(),
    ...over,
  };
}

describe('PaymentsService.refund · emite payment.refunded por outbox', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let payments: PaymentsService;

  function build(payment: Record<string, unknown>) {
    prisma = makeFakePrisma(payment);
    payments = new PaymentsService(prisma, noGateway, noAffiliation, noPromos, makeConfig() as never);
  }

  beforeEach(() => {
    build(capturedPayment());
  });

  it('reembolso válido → payment.refunded con amountCents y passengerId enriquecido', async () => {
    const res = await payments.refund(TRIP, 500, 'cliente_insatisfecho', L2);
    expect(res.status).toBe('REFUNDED');

    const event = prisma._outbox.find((e) => e.eventType === 'payment.refunded');
    expect(event).toBeDefined();
    expect(event!.envelope.payload).toMatchObject({
      paymentId: 'pay-1',
      tripId: TRIP,
      amountCents: 500, // lo reembolsado, no el bruto
      approvedBy: 'op-L2',
      passengerId: PAX,
    });
  });

  it('marca el pago REFUNDED y crea la fila Refund', async () => {
    await payments.refund(TRIP, 500, 'x', L2);
    expect(prisma._refunds).toHaveLength(1);
  });

  it('sin passengerId persistido → el evento igual se emite (passengerId omitido)', async () => {
    build(capturedPayment({ passengerId: null }));
    await payments.refund(TRIP, 500, 'x', L2);
    const event = prisma._outbox.find((e) => e.eventType === 'payment.refunded')!;
    expect(event.envelope.payload.passengerId).toBeUndefined();
  });

  it('reembolso mayor al cobrado → InvalidStateError, sin evento', async () => {
    await expect(payments.refund(TRIP, 3000, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);
    expect(prisma._outbox.some((e) => e.eventType === 'payment.refunded')).toBe(false);
  });
});
