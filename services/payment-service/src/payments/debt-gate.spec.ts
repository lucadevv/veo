/**
 * DEBT gate (BR-P02) · payment-service:
 *   - getDebtForPassenger: lista los cobros en DEBT del pasajero (shape, total, orden), filtrando por
 *     passengerId + status=DEBT (el índice [passengerId, status] cubre la query).
 *   - retryCharge (saldar deuda): transición DEBT→CAPTURED (sandbox), idempotencia sobre CAPTURED
 *     (no-op), concurrencia (status-guard updateMany: solo un llamador gana), y estados inválidos.
 * Prisma fake en memoria (sin red): doble determinista y total (no mockeamos un crítico parcialmente).
 */
import { describe, it, expect } from 'vitest';
import { type ConfigService } from '@nestjs/config';
import { InvalidStateError, NotFoundError } from '@veo/utils';
import { PaymentsService } from './payments.service';
import { SandboxPaymentGateway } from '../ports/gateway/sandbox.gateway';
import type { PrismaService } from '../infra/prisma.service';
import type { AffiliationsService } from '../affiliations/affiliations.service';
import type { PromotionsService } from '../promotions/promotions.service';
import type { Env } from '../config/env.schema';

const PAX = '0192f8a0-0000-7000-8000-0000000000aa';
const OTHER = '0192f8a0-0000-7000-8000-0000000000bb';

interface Row {
  id: string;
  tripId: string;
  passengerId: string | null;
  amountCents: number;
  grossCents: number;
  method: string;
  status: string;
  failureReason: string | null;
  payerRef: string | null;
  dedupKey: string;
  retries: number;
  createdAt: Date;
  // Checkout (ProntoPaga): presentes en un PENDING accionable (kind=PENDING_ACTION).
  externalUid: string | null;
  checkoutUrl: string | null;
  deepLink: string | null;
  qrCode: string | null;
  cip: string | null;
}

/** Fake Prisma con findMany/findUnique/update/updateMany + outbox, sobre un mapa en memoria. */
function makeFakePrisma(seed: Row[]) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  const outbox: { eventType: string; aggregateId: string }[] = [];
  const client = {
    payment: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { passengerId?: string; status?: string };
        orderBy?: { createdAt?: 'asc' | 'desc' };
        select?: unknown;
      }) => {
        let out = [...rows.values()].filter(
          (r) =>
            (where.passengerId === undefined || r.passengerId === where.passengerId) &&
            (where.status === undefined || r.status === where.status),
        );
        if (orderBy?.createdAt === 'asc') out = out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return out;
      },
      findUnique: async ({ where }: { where: { id?: string; dedupKey?: string } }) => {
        if (where.id) return rows.get(where.id) ?? null;
        if (where.dedupKey) return [...rows.values()].find((r) => r.dedupKey === where.dedupKey) ?? null;
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.get(where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<Row>;
      }) => {
        const r = rows.get(where.id);
        if (!r || (where.status !== undefined && r.status !== where.status)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  (client as Record<string, unknown>).outboxEvent = {
    create: async ({ data }: { data: { eventType: string; aggregateId: string } }) => {
      outbox.push({ eventType: data.eventType, aggregateId: data.aggregateId });
      return data;
    },
  };
  return { read: client, write: client, _rows: rows, _outbox: outbox } as unknown as PrismaService & {
    _rows: Map<string, Row>;
    _outbox: { eventType: string; aggregateId: string }[];
  };
}

function makeConfig(mode: 'sandbox' | 'prontopaga' = 'sandbox'): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: mode,
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
  };
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
}

const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;

function debtRow(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? '0192f8a0-0000-7000-8000-000000000d01',
    tripId: over.tripId ?? '0192f8a0-0000-7000-8000-000000000t01',
    passengerId: over.passengerId ?? PAX,
    amountCents: over.amountCents ?? 2300,
    grossCents: over.grossCents ?? 2000,
    method: over.method ?? 'YAPE',
    status: over.status ?? 'DEBT',
    failureReason: over.failureReason ?? 'yape_insufficient_funds',
    payerRef: over.payerRef ?? null,
    dedupKey: over.dedupKey ?? `trip-completed:${over.tripId ?? 't01'}`,
    retries: over.retries ?? 3,
    createdAt: over.createdAt ?? new Date('2026-06-01T00:00:00Z'),
    externalUid: over.externalUid ?? null,
    checkoutUrl: over.checkoutUrl ?? null,
    deepLink: over.deepLink ?? null,
    qrCode: over.qrCode ?? null,
    cip: over.cip ?? null,
  };
}

describe('getDebtForPassenger (deuda del pasajero)', () => {
  it('sin deuda → hasDebt=false, total 0, lista vacía', async () => {
    const prisma = makeFakePrisma([debtRow({ status: 'CAPTURED' })]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(false);
    expect(out.totalCents).toBe(0);
    expect(out.debts).toEqual([]);
  });

  it('con dos deudas → hasDebt=true, total sumado, orden por createdAt asc (más antigua primero) y shape', async () => {
    const older = debtRow({ id: 'd-old', tripId: 't-old', amountCents: 1000, createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = debtRow({ id: 'd-new', tripId: 't-new', amountCents: 2500, createdAt: new Date('2026-06-05T00:00:00Z') });
    const prisma = makeFakePrisma([newer, older]); // insertados desordenados a propósito
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());

    const out = await svc.getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(3500);
    expect(out.debts.map((d) => d.tripId)).toEqual(['t-old', 't-new']); // orden asc
    expect(out.debts[0]).toMatchObject({
      paymentId: 'd-old',
      tripId: 't-old',
      amountCents: 1000,
      reason: 'yape_insufficient_funds',
    });
    expect(typeof out.debts[0]?.createdAt).toBe('string'); // ISO
  });

  it('NO devuelve la deuda de OTRO pasajero (filtra por passengerId)', async () => {
    const prisma = makeFakePrisma([debtRow({ passengerId: OTHER })]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(false);
  });

  it('cada deuda lleva kind=DEBT', async () => {
    const prisma = makeFakePrisma([debtRow()]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    expect(out.debts).toHaveLength(1);
    expect(out.debts[0]?.kind).toBe('DEBT');
  });

  it('PENDING con checkout vivo (deepLink) → PENDING_ACTION; NO cuenta como deuda (hasDebt=false, total 0)', async () => {
    const pending = debtRow({
      id: 'p-pending',
      tripId: 't-pending',
      status: 'PENDING',
      failureReason: null,
      externalUid: '01KTHPQ6RPD4J2P7NWFKGRNPJG',
      deepLink: 'yapeapp:oneshot/abc',
    });
    const prisma = makeFakePrisma([pending]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    // El gate NO se dispara por un pago por completar.
    expect(out.hasDebt).toBe(false);
    expect(out.totalCents).toBe(0);
    expect(out.debts).toHaveLength(1);
    expect(out.debts[0]).toMatchObject({ paymentId: 'p-pending', tripId: 't-pending', kind: 'PENDING_ACTION' });
  });

  it('PENDING SIN checkout (efectivo / on-file sin medios) → NO accionable, se excluye', async () => {
    const cashPending = debtRow({ id: 'p-cash', status: 'PENDING', method: 'CASH', failureReason: null });
    const onfilePending = debtRow({ id: 'p-onfile', status: 'PENDING', failureReason: null, externalUid: 'uid-x' }); // sin medios
    const prisma = makeFakePrisma([cashPending, onfilePending]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    expect(out.debts).toEqual([]);
    expect(out.hasDebt).toBe(false);
  });

  it('mezcla DEBT + PENDING_ACTION → DEBT primero, total SOLO de la deuda, hasDebt=true', async () => {
    const debt = debtRow({ id: 'd1', tripId: 't-debt', amountCents: 2300, createdAt: new Date('2026-06-01T00:00:00Z') });
    const pending = debtRow({
      id: 'pa1',
      tripId: 't-pa',
      amountCents: 3600,
      status: 'PENDING',
      failureReason: null,
      createdAt: new Date('2026-06-02T00:00:00Z'),
      externalUid: '01KTHPQ6RPD4J2P7NWFKGRNPJG',
      deepLink: 'yapeapp:oneshot/xyz',
    });
    const prisma = makeFakePrisma([pending, debt]);
    const svc = new PaymentsService(prisma, noAffiliation as never, noAffiliation, noPromos, makeConfig());
    const out = await svc.getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(2300); // SOLO la deuda; el PENDING_ACTION (3600) no suma
    expect(out.debts.map((d) => d.kind)).toEqual(['DEBT', 'PENDING_ACTION']);
    expect(out.debts.map((d) => d.tripId)).toEqual(['t-debt', 't-pa']);
  });
});

describe('retryCharge (saldar deuda)', () => {
  it('sandbox: DEBT → re-cobro al riel → CAPTURED (payerRef no termina en 0000)', async () => {
    const row = debtRow({ payerRef: '51999111222' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));

    const out = await svc.retryCharge(row.id);
    expect(out.status).toBe('CAPTURED');
    expect(prisma._outbox.some((e) => e.eventType === 'payment.captured')).toBe(true);
  });

  it('sandbox: el riel vuelve a rechazar (payerRef 0000) → de vuelta a DEBT', async () => {
    const row = debtRow({ payerRef: '51900000000' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));

    const out = await svc.retryCharge(row.id);
    expect(out.status).toBe('DEBT');
  });

  it('idempotente: sobre un cobro YA CAPTURED → no-op (no re-cobra, devuelve estado)', async () => {
    const row = debtRow({ status: 'CAPTURED' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));

    const out = await svc.retryCharge(row.id);
    expect(out.status).toBe('CAPTURED');
    expect(prisma._outbox).toHaveLength(0); // no emitió nada nuevo
  });

  it('concurrencia: el status-guard transaccional (updateMany where status=DEBT) deja pasar a UNO solo', async () => {
    const row = debtRow({ payerRef: '51999111222' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));

    const [a, b] = await Promise.all([svc.retryCharge(row.id), svc.retryCharge(row.id)]);
    // El status-guard deja re-cobrar a UNO solo → UNA sola captura emitida (no doble cobro), y el
    // pago final queda CAPTURED. (El llamador perdedor devuelve el estado vigente sin re-cobrar.)
    expect(a.id).toBe(b.id);
    const captured = prisma._outbox.filter((e) => e.eventType === 'payment.captured');
    expect(captured).toHaveLength(1);
    const final = await svc.getPayment(row.id);
    expect(final.status).toBe('CAPTURED');
  });

  it('PENDING (cobro/re-cobro en curso) → no-op idempotente (devuelve estado, no re-cobra)', async () => {
    const row = debtRow({ status: 'PENDING' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));
    const out = await svc.retryCharge(row.id);
    expect(out.status).toBe('PENDING');
    expect(prisma._outbox).toHaveLength(0); // no disparó otro cobro
  });

  it('FAILED (cobro externo cancelado, estado terminal) → InvalidStateError', async () => {
    const row = debtRow({ status: 'FAILED' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));
    await expect(svc.retryCharge(row.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('CASH: una deuda en efectivo NO se re-cobra al riel → InvalidStateError', async () => {
    const row = debtRow({ method: 'CASH' });
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));
    await expect(svc.retryCharge(row.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('pago inexistente → NotFoundError', async () => {
    const prisma = makeFakePrisma([]);
    const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('sandbox'));
    await expect(svc.retryCharge('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('prontopaga: DEBT → re-cobro asíncrono → PENDING con checkout nuevo (urlPay/qr)', async () => {
    const row = debtRow();
    const prisma = makeFakePrisma([row]);
    const gateway = new SandboxPaymentGateway({
      confirmDelayMs: 0,
      declineSuffix: '0000',
      pendingExternal: true,
      webhookSecret: 'sec',
    });
    const svc = new PaymentsService(prisma, gateway, noAffiliation, noPromos, makeConfig('prontopaga'));

    const out = await svc.retryCharge(row.id);
    expect(out.status).toBe('PENDING'); // espera webhook/poll
    expect(out.checkoutUrl ?? out.qrCode).toBeTruthy(); // checkout nuevo persistido
  });
});
