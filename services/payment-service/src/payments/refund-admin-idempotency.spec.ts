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
import type { PaymentTx } from './payments.repository';

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

/**
 * Repo fake (mock del SEAM PaymentsRepository) que HONRA el UNIQUE de `refund.dedupKey` y expone
 * `findRefundByDedupKeyOnPrimary` (path P2002→existente, read-after-write en el primario).
 */
function makeRepo(payment: FakePayment | null) {
  const refunds: FakeRefund[] = [];
  const usedDedupKeys = new Set<string>();

  const createRefundInTx = vi.fn(async (_tx: PaymentTx, data: FakeRefund) => {
    if (data.dedupKey) {
      if (usedDedupKeys.has(data.dedupKey)) throw uniqueViolation('dedup_key');
      usedDedupKeys.add(data.dedupKey);
    }
    refunds.push(data);
    return data;
  });

  const repo = {
    findRefundablePaymentByTrip: vi.fn(async (tripId: string) =>
      payment?.tripId === tripId && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)
        ? payment
        : null,
    ),
    runInTransaction: async <T>(work: (tx: PaymentTx) => Promise<T>): Promise<T> =>
      work({} as PaymentTx),
    // Advisory lock transaccional del backstop de ventana (pg_advisory_xact_lock): no-op en el doble.
    acquirePaymentAdvisoryLock: vi.fn(async () => {}),
    // Backstop de VENTANA: refund reciente NO-RECHAZADO del MISMO (paymentId, amountCents). El doble trata TODOS
    // los refunds como "dentro de la ventana" (ignora createdAt) → peor caso (idempotencia más agresiva).
    findRecentRefundInWindowInTx: vi.fn(
      async (_tx: PaymentTx, paymentId: string, amountCents: number) =>
        refunds.find(
          (r) => r.paymentId === paymentId && r.amountCents === amountCents && r.status !== 'REJECTED',
        ) ?? null,
    ),
    casClaimRefundReservation: vi.fn(
      async (
        _tx: PaymentTx,
        paymentId: string,
        expectedRefundedCents: number,
        data: Partial<FakePayment>,
      ) => {
        if (
          payment?.id !== paymentId ||
          !['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) ||
          payment.refundedCents !== expectedRefundedCents
        ) {
          return { count: 0 };
        }
        Object.assign(payment, data);
        return { count: 1 };
      },
    ),
    // A2 · reverseCashDebtInTx consulta la deuda del cobro CASH al reembolsar; sin deuda en estos escenarios → null.
    findDriverDebtByPaymentInTx: vi.fn(async () => null),
    createRefundInTx,
    enqueueOutbox: vi.fn(async () => {}),
    // El handler de idempotencia relee del PRIMARIO (read-after-write): el doble busca por dedupKey.
    findRefundByDedupKeyOnPrimary: vi.fn(
      async (dedupKey: string) => refunds.find((r) => r.dedupKey === dedupKey) ?? null,
    ),
  };

  return { repo, refunds, txRefundCreate: createRefundInTx };
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
      REFUND_IDEMPOTENCY_WINDOW_MINUTES: 15,
      CANCELLATION_DRIVER_SHARE: 0,
    };
    return map[k];
  },
} as never;

function buildService(repo: ReturnType<typeof makeRepo>['repo']): PaymentsService {
  return new PaymentsService(repo as never, {} as never, {} as never, {} as never, config);
}

const operator: AuthenticatedUser = {
  userId: 'op-1',
  roles: [AdminRole.ADMIN],
} as AuthenticatedUser;

describe('PaymentsService.refund · idempotencia admin (Idempotency-Key)', () => {
  it('CON Idempotency-Key: persiste dedupKey derivada del key (barrera dura)', async () => {
    const { repo, refunds } = makeRepo(capturedPayment());
    const svc = buildService(repo);

    const res = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-A');

    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-A'));
    expect(res.refundId).toBe(refunds[0]!.id);
  });

  it('SIN Idempotency-Key: dedupKey NULL (compat — idempotencia = CAS optimista, como antes)', async () => {
    const { repo, refunds } = makeRepo(capturedPayment());
    const svc = buildService(repo);

    await svc.refund('trip-1', 1000, 'ajuste', operator);

    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.dedupKey).toBeNull();
  });

  it('LO CRÍTICO — reintento con el MISMO key (refund parcial ya creado) → devuelve el EXISTENTE, NO doble plata', async () => {
    const { repo, refunds, txRefundCreate } = makeRepo(capturedPayment());
    // Pre-existe el refund de ESTE key (un primer submit que el server SÍ commiteó, pero el cliente vio un
    // error de red ambiguo y reintenta con el MISMO Idempotency-Key estable).
    await txRefundCreate({} as never, {
        id: 'refund-existente',
        paymentId: 'pay-1',
        amountCents: 1000,
        requestedBy: 'op-1',
        approvedBy: 'op-1',
        dedupKey: deriveAdminRefundDedupKey('KEY-A'),
        status: 'COMPLETED',
        reason: 'ajuste',
    });
    const svc = buildService(repo);

    const res = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-A');

    // El 2do intento chocó contra el UNIQUE (P2002) → devolvió el refund existente (mismo pago y monto), sin
    // crear uno nuevo.
    expect(res.refundId).toBe('refund-existente');
    expect(refunds).toHaveLength(1);
  });

  it('mismo key pero OTRO monto (operador editó el form tras un timeout) → CONFLICTO, NO éxito falso', async () => {
    const { repo, txRefundCreate } = makeRepo(capturedPayment({ amountCents: 4500 }));
    // El primer submit (monto 1000) ya commiteó server-side con el key K.
    await txRefundCreate({} as never, {
        id: 'refund-de-1000',
        paymentId: 'pay-1',
        amountCents: 1000,
        requestedBy: 'op-1',
        approvedBy: 'op-1',
        dedupKey: deriveAdminRefundDedupKey('KEY-A'),
        status: 'COMPLETED',
        reason: 'ajuste',
    });
    const svc = buildService(repo);

    // El operador edita el monto a 500 y reenvía con el MISMO key: NO debe devolver el refund de 1000 como
    // éxito (sería un sub-reembolso enmascarado) → conflicto explícito.
    await expect(svc.refund('trip-1', 500, 'ajuste', operator, 'KEY-A')).rejects.toThrow(
      /distinto pago o monto/,
    );
  });

  it('mismo key, mismo dinero (pago+monto), OTRO motivo → DEDUP (el motivo NO es identidad de dinero)', async () => {
    // Un reintento donde el operador editó el motivo libre sigue siendo la MISMA operación de dinero: debe
    // devolver el existente (no doble-pagar, no conflicto). El motivo no entra en la identidad del key.
    const { repo, txRefundCreate } = makeRepo(capturedPayment({ amountCents: 4500 }));
    await txRefundCreate({} as never, {
        id: 'refund-motivo-A',
        paymentId: 'pay-1',
        amountCents: 1000,
        requestedBy: 'op-1',
        approvedBy: 'op-1',
        dedupKey: deriveAdminRefundDedupKey('KEY-A'),
        status: 'COMPLETED',
        reason: 'motivo A',
    });
    const svc = buildService(repo);

    const res = await svc.refund('trip-1', 1000, 'motivo B', operator, 'KEY-A');
    expect(res.refundId).toBe('refund-motivo-A');
  });

  it('keys distintos, mismo dinero, SIN forceNew → BACKSTOP DE VENTANA dedupea (NO doble-paga aunque el key diverja)', async () => {
    // El cierre DURO del residual del nonce de cliente: aunque el 2do intento traiga un Idempotency-Key DISTINTO
    // (storage bloqueado / otra pestaña / otro dispositivo re-acuñaron uno nuevo), el server lo trata como la
    // MISMA operación de dinero (mismo paymentId+monto, dentro de la ventana) → devuelve el existente, NO crea otro.
    const { repo, refunds } = makeRepo(capturedPayment({ amountCents: 4500 }));
    const svc = buildService(repo);

    const first = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-A');
    const second = await svc.refund('trip-1', 1000, 'ajuste', operator, 'KEY-B'); // key DIVERGENTE, sin forceNew

    expect(refunds).toHaveLength(1); // un solo money-OUT
    expect(second.refundId).toBe(first.refundId); // el 2do devolvió el existente
  });

  it('keys distintos, mismo dinero, CON forceNew → DOS refunds (el operador habilita el 2do parcial idéntico)', async () => {
    // El gesto explícito del operador salta el backstop de ventana: dos parciales LEGÍTIMOS idénticos no colapsan.
    const { repo, refunds } = makeRepo(capturedPayment({ amountCents: 4500 }));
    const svc = buildService(repo);

    await svc.refund('trip-1', 1000, 'ajuste 1', operator, 'KEY-A');
    await svc.refund('trip-1', 1000, 'ajuste 2', operator, 'KEY-B', true); // forceNew=true

    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-A'));
    expect(refunds[1]!.dedupKey).toBe(deriveAdminRefundDedupKey('KEY-B'));
  });
});
