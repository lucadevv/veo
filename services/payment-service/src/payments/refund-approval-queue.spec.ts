/**
 * Máquina de estados de la COLA DE APROBACIÓN de reembolsos (money-OUT · frame HZ8uz). Ejercita el ciclo completo
 * sobre un cobro CASH (sin gateway): SOLICITAR (PENDING, sin desembolsar) → APROBAR (desembolsa idempotente →
 * COMPLETED, reserva el cobro) · RECHAZAR (PENDING → REJECTED, sin mover plata). Cubre lo NO negociable:
 *  - la solicitud NO reserva el cobro (la plata se mueve SOLO al aprobar);
 *  - aprobar es IDEMPOTENTE (doble-submit → mismo estado, sin re-desembolsar);
 *  - el gate de monto alto (dual-control) se aplica al APROBAR (no al solicitar);
 *  - rechazar SOLO una solicitud PENDING (una COMPLETED es terminal), sin compensación;
 *  - aprobar RE-valida el saldo (si el cobro se movió entre solicitar y aprobar, no desembolsa de más).
 *
 * Estilo del repo (como refund-admin-idempotency / refund-booking-cancellation): dobles de Prisma a mano que HONRAN
 * los CAS por status y la reserva optimista del cobro. Determinista (sin testcontainers).
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';
import { AdminRole } from '@veo/shared-types';
import type { AuthenticatedUser } from '@veo/auth';
import type { PaymentTx } from './payments.repository';

interface FakePayment {
  id: string;
  tripId: string;
  method: string;
  grossCents: number;
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
  failureReason: string | null;
}

function capturedCashPayment(over: Partial<FakePayment> = {}): FakePayment {
  return {
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'CASH',
    grossCents: 4500,
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

function makeRepo(payment: FakePayment) {
  const refunds: FakeRefund[] = [];
  const outbox: string[] = [];

  const repo = {
    findRefundablePaymentByTrip: vi.fn(async (tripId: string) =>
      payment.tripId === tripId && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)
        ? payment
        : null,
    ),
    findPaymentById: vi.fn(async (id: string) => (payment.id === id ? payment : null)),
    findRefundById: vi.fn(async (id: string) => refunds.find((r) => r.id === id) ?? null),
    runInTransaction: async <T>(work: (tx: PaymentTx) => Promise<T>): Promise<T> =>
      work({} as PaymentTx),
    acquirePaymentAdvisoryLock: vi.fn(async () => {}),
    // Backstop de ventana (idempotencia de la SOLICITUD): refund reciente NO-RECHAZADO del mismo (pago, monto).
    findRecentRefundInWindowInTx: vi.fn(
      async (_tx: PaymentTx, paymentId: string, amountCents: number) =>
        refunds.find(
          (r) => r.paymentId === paymentId && r.amountCents === amountCents && r.status !== 'REJECTED',
        ) ?? null,
    ),
    createRefundInTx: vi.fn(async (_tx: PaymentTx, data: Partial<FakeRefund> & Pick<FakeRefund, 'id' | 'paymentId' | 'amountCents' | 'requestedBy' | 'status' | 'reason'>) => {
      const row: FakeRefund = {
        id: data.id,
        paymentId: data.paymentId,
        amountCents: data.amountCents,
        requestedBy: data.requestedBy,
        approvedBy: data.approvedBy ?? null,
        dedupKey: data.dedupKey ?? null,
        status: data.status,
        reason: data.reason,
        failureReason: data.failureReason ?? null,
      };
      refunds.push(row);
      return row;
    }),
    findRefundByDedupKeyOnPrimary: vi.fn(
      async (dedupKey: string) => refunds.find((r) => r.dedupKey === dedupKey) ?? null,
    ),
    // CAS-RESERVA del cobro (solo al APROBAR): reclama si sigue reembolsable Y el saldo no cambió.
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
    // CAS de avance desde la cola: PENDING → APPROVED/COMPLETED (idempotente).
    casApproveRefundFromPending: vi.fn(
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
    // Rechazo del operador (PENDING → REJECTED, sin compensación).
    rejectPendingRefund: vi.fn(async (refundId: string, data: Partial<FakeRefund>) => {
      const r = refunds.find((x) => x.id === refundId && x.status === 'PENDING');
      if (!r) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    }),
    findDriverDebtByPaymentInTx: vi.fn(async () => null),
    enqueueOutbox: vi.fn(async (_tx: PaymentTx, envelope: { eventType: string }) => {
      outbox.push(envelope.eventType);
    }),
  };

  return { repo, refunds, outbox };
}

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

const finance: AuthenticatedUser = { userId: 'fin-1', roles: [AdminRole.FINANCE] } as AuthenticatedUser;
const admin: AuthenticatedUser = { userId: 'adm-1', roles: [AdminRole.ADMIN] } as AuthenticatedUser;

describe('Cola de aprobación de reembolsos · máquina de estados (CASH)', () => {
  it('SOLICITAR crea PENDING y NO reserva el cobro (la plata NO se mueve hasta aprobar)', async () => {
    const payment = capturedCashPayment();
    const { repo, refunds } = makeRepo(payment);
    const svc = buildService(repo);

    const res = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);

    expect(res.status).toBe('PENDING');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('PENDING');
    expect(refunds[0]!.approvedBy).toBeNull();
    // El cobro sigue intacto: sin reserva, sin cambio de saldo/estado.
    expect(payment.refundedCents).toBe(0);
    expect(payment.status).toBe('CAPTURED');
    expect(repo.casClaimRefundReservation).not.toHaveBeenCalled();
  });

  it('APROBAR desembolsa CASH → COMPLETED, reserva el cobro y emite payment.refunded', async () => {
    const payment = capturedCashPayment();
    const { repo, refunds, outbox } = makeRepo(payment);
    const svc = buildService(repo);

    const { refundId } = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);
    const res = await svc.approveRefund(refundId, finance);

    expect(res.status).toBe('COMPLETED');
    expect(refunds[0]!.status).toBe('COMPLETED');
    expect(refunds[0]!.approvedBy).toBe('fin-1'); // el aprobador firma la aprobación
    // Ahora sí se reservó el cobro (parcial): saldo movido y estado PARTIALLY_REFUNDED.
    expect(payment.refundedCents).toBe(1000);
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
    expect(outbox).toContain('payment.refunded');
  });

  it('APROBAR es IDEMPOTENTE: un 2do approve NO re-desembolsa (mismo estado, sin doble reserva)', async () => {
    const payment = capturedCashPayment();
    const { repo, refunds } = makeRepo(payment);
    const svc = buildService(repo);

    const { refundId } = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);
    await svc.approveRefund(refundId, finance);
    const second = await svc.approveRefund(refundId, finance);

    expect(second.status).toBe('COMPLETED');
    expect(payment.refundedCents).toBe(1000); // NO se sumó de nuevo
    expect(refunds).toHaveLength(1);
    // La reserva se intentó UNA sola vez (el 2do approve cortó por idempotencia antes de reservar).
    expect(repo.casClaimRefundReservation).toHaveBeenCalledTimes(1);
  });

  it('RECHAZAR una solicitud PENDING → REJECTED con motivo, SIN tocar el cobro (nunca reservó)', async () => {
    const payment = capturedCashPayment();
    const { repo, refunds } = makeRepo(payment);
    const svc = buildService(repo);

    const { refundId } = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);
    const res = await svc.rejectRefund(refundId, finance, 'no corresponde');

    expect(res.status).toBe('REJECTED');
    expect(refunds[0]!.status).toBe('REJECTED');
    expect(refunds[0]!.failureReason).toBe('no corresponde');
    expect(payment.refundedCents).toBe(0);
    expect(payment.status).toBe('CAPTURED');
  });

  it('RECHAZAR es idempotente y SOLO aplica a PENDING: una COMPLETED no se rechaza', async () => {
    const payment = capturedCashPayment();
    const { repo } = makeRepo(payment);
    const svc = buildService(repo);

    const { refundId } = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);
    await svc.approveRefund(refundId, finance); // COMPLETED

    await expect(svc.rejectRefund(refundId, finance, 'tarde')).rejects.toThrow(
      /solo una solicitud pendiente/i,
    );
  });

  it('GATE de monto alto se aplica al APROBAR: FINANCE no aprueba >umbral; ADMIN sí', async () => {
    const payment = capturedCashPayment({ amountCents: 5000 });
    const { repo, refunds } = makeRepo(payment);
    const svc = buildService(repo);

    // FINANCE puede SOLICITAR el monto alto (no hay gate al solicitar)...
    const { refundId } = await svc.requestRefund('trip-1', 5000, 'reembolso total', finance);
    expect(refunds[0]!.status).toBe('PENDING');

    // ...pero NO puede aprobarlo (dual-control: >umbral requiere ADMIN/SUPERADMIN).
    await expect(svc.approveRefund(refundId, finance)).rejects.toThrow(/ADMIN o SUPERADMIN/);
    expect(payment.refundedCents).toBe(0); // no desembolsó

    // Un ADMIN sí lo aprueba.
    const res = await svc.approveRefund(refundId, admin);
    expect(res.status).toBe('COMPLETED');
    expect(payment.refundedCents).toBe(5000);
  });

  it('APROBAR RE-valida el saldo: si el cobro se reembolsó por otra vía, NO desembolsa de más', async () => {
    const payment = capturedCashPayment();
    const { repo } = makeRepo(payment);
    const svc = buildService(repo);

    const { refundId } = await svc.requestRefund('trip-1', 1000, 'ajuste', finance);
    // Entre solicitar y aprobar, el cobro quedó TOTALMENTE reembolsado por otra operación.
    payment.refundedCents = 4500;
    payment.status = 'REFUNDED';

    await expect(svc.approveRefund(refundId, finance)).rejects.toThrow(/excede el saldo/i);
  });
});
