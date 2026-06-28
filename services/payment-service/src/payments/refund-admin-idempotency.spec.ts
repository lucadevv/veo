/**
 * Idempotencia del refund ADMIN discrecional (cierre de la ALTA del audit del panel de finanzas): cuando el
 * operador trae un `Idempotency-Key` desde el panel, el refund se vuelve IDEMPOTENTE de verdad — un doble-submit
 * o un reintento de red con el MISMO key NO doble-reembolsa (UNIQUE PARCIAL en `Refund.dedupKey`, status <>
 * REJECTED). El refund PARCIAL NO lo blindaba la máquina de estados (el CAS solo impide exceder el saldo, no hace
 * idempotente la operación lógica), así que el key es la barrera real. Sin key ⇒ dedupKey NULL (compat: como antes).
 *
 * Estilo del repo: dobles de Prisma a mano que HONRAN el UNIQUE de `refund.dedupKey` (como refund-booking-cancellation.spec).
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../generated/prisma';
import { PaymentsService } from './payments.service';
import { AdminRole } from '@veo/shared-types';
import { deriveAdminRefundDedupKey } from './payment.policy';
import type { AuthenticatedUser } from '@veo/auth';
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

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: [target] },
  });
}

// Cobro CASH reciente (dentro de la ventana de reembolso) para ejercitar el CORE sin gateway.
function capturedPayment(over: Partial<FakePayment> = {}): FakePayment {
  return {
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'CASH',
    passengerId: 'pax-1',
    status: 'CAPTURED',
    amountCents: 4500,
    refundedCents: 0,
    refundedAt: null,
    capturedAt: new Date(),
    createdAt: new Date(),
    externalRef: null,
    externalUid: null,
    ...over,
  };
}

/** Prisma double que HONRA el UNIQUE de `refund.dedupKey` y expone `read.refund.findFirst` (path P2002→existente). */
function makePrisma(payment: FakePayment | null) {
  const refunds: FakeRefund[] = [];
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
    outboxEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
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
      refund: {
        findFirst: vi.fn(async ({ where }: { where: { dedupKey: string } }) =>
          refunds.find((r) => r.dedupKey === where.dedupKey) ?? null,
        ),
      },
    },
    write: {
      $transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    },
  } as unknown as PrismaService;

  return { prisma, refunds, txRefundCreate: tx.refund.create };
}

// El constructor lee números de config; el camino CASH no toca gateway/affiliations/promotions/credit.
const config = {
  getOrThrow: (k: string) => {
    const map: Record<string, unknown> = {
      COMMISSION_RATE: 0,
      PAYMENT_MAX_RETRIES: 0,
      PAYMENT_RETRY_BASE_MS: 0,
      DEFAULT_PAYMENT_METHOD: 'CASH',
      REFUND_WINDOW_DAYS: 36500,
      REFUND_L2_THRESHOLD_CENTS: 3000,
      CANCELLATION_DRIVER_SHARE: 0,
    };
    return map[k];
  },
} as never;

function buildService(prisma: PrismaService): PaymentsService {
  return new PaymentsService(prisma, {} as never, {} as never, {} as never, config);
}

const operator: AuthenticatedUser = {
  userId: 'op-1',
  roles: [AdminRole.ADMIN],
} as AuthenticatedUser;

describe('PaymentsService.refund · idempotencia admin (Idempotency-Key)', () => {
  it('CON Idempotency-Key: persiste dedupKey derivada del key (barrera dura)', async () => {
    const { prisma, refunds } = makePrisma(capturedPayment());
    const svc = buildService(prisma);

    const res = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-A');

    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-A'));
    expect(res.refundId).toBe(refunds[0]!.id);
  });

  it('SIN Idempotency-Key: dedupKey NULL (compat — idempotencia = CAS optimista, como antes)', async () => {
    const { prisma, refunds } = makePrisma(capturedPayment());
    const svc = buildService(prisma);

    await svc.refund('trip-1', 1000, 'ajuste', operator);

    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.dedupKey).toBeNull();
  });

  it('LO CRÍTICO — reintento con el MISMO key (refund parcial ya creado) → devuelve el EXISTENTE, NO doble plata', async () => {
    const { prisma, refunds, txRefundCreate } = makePrisma(capturedPayment());
    // Pre-existe el refund de ESTE key (un primer submit que el server SÍ commiteó, pero el cliente vio un
    // error de red ambiguo y reintenta con el MISMO Idempotency-Key estable).
    await txRefundCreate({
      data: {
        id: 'refund-existente',
        paymentId: 'pay-1',
        amountCents: 1000,
        requestedBy: 'op-1',
        approvedBy: 'op-1',
        dedupKey: deriveAdminRefundDedupKey('KEY-A'),
        status: 'COMPLETED',
        reason: 'ajuste',
      },
    } as never);
    const svc = buildService(prisma);

    const res = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-A');

    // El 2do intento chocó contra el UNIQUE (P2002) → devolvió el refund existente, sin crear uno nuevo.
    expect(res.refundId).toBe('refund-existente');
    expect(refunds).toHaveLength(1);
  });

  it('keys DISTINTOS → refunds DISTINTOS (dos parciales legítimos no se colapsan)', async () => {
    const { prisma, refunds } = makePrisma(capturedPayment({ amountCents: 4500 }));
    const svc = buildService(prisma);

    await svc.refund('trip-1', 1000, 'ajuste 1', operator, 'KEY-A');
    await svc.refund('trip-1', 1000, 'ajuste 2', operator, 'KEY-B');

    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-A'));
    expect(refunds[1]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-B'));
  });
});
