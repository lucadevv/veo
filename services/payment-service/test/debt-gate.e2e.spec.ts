/**
 * DEBT gate (BR-P02) · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en un crítico de
 * dinero (CLAUDE). Reemplaza al antiguo debt-gate.spec.ts (fake Prisma en memoria).
 *   - getDebtForPassenger: lista los cobros en DEBT del pasajero (shape, total, orden), filtrando por
 *     passengerId + status=DEBT (índice [passengerId, status]). PENDING_ACTION (checkout vivo) NO bloquea.
 *   - retryCharge (saldar deuda): DEBT→CAPTURED (sandbox), idempotencia sobre CAPTURED/PENDING (no-op),
 *     concurrencia (status-guard updateMany where status=DEBT: un solo ganador), estados inválidos.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { InvalidStateError, NotFoundError, uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';
const OTHER = '0192f8a0-0000-7000-8000-0000000000bb';

let db: TestDatabase;
let prisma: PrismaClient;

const noPromos = {
  redeemPromo: async () => ({ discountCents: 0 }),
} as unknown as PromotionsService;
const noAffiliation = {
  resolveActiveWalletUid: async () => null,
} as unknown as AffiliationsService;

function makeConfig(mode: 'sandbox' | 'prontopaga' = 'sandbox'): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: mode,
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
    REFUND_IDEMPOTENCY_WINDOW_MINUTES: 15,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

/** Construye un PaymentsService real apuntando al contenedor, con el gateway/modo del caso. */
function makeService(
  gateway: SandboxPaymentGateway,
  mode: 'sandbox' | 'prontopaga' = 'sandbox',
): PaymentsService {
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  return new PaymentsService(
    prismaService,
    gateway,
    noAffiliation,
    noPromos,
    makeConfig(mode) as never,
  );
}

interface SeedOver {
  id?: string;
  tripId?: string;
  passengerId?: string | null;
  amountCents?: number;
  grossCents?: number;
  method?: string;
  status?: string;
  failureReason?: string | null;
  payerRef?: string | null;
  retries?: number;
  createdAt?: Date;
  externalUid?: string | null;
  checkoutUrl?: string | null;
  deepLink?: string | null;
  qrCode?: string | null;
  cip?: string | null;
}

/** Inserta un Payment real con los campos mínimos requeridos del modelo. Devuelve {id, tripId}. */
async function seedPayment(over: SeedOver = {}): Promise<{ id: string; tripId: string }> {
  const id = over.id ?? uuidv7();
  const tripId = over.tripId ?? uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: over.passengerId === undefined ? PAX : over.passengerId,
      dedupKey: `trip-completed:${tripId}`,
      amountCents: over.amountCents ?? 2300,
      grossCents: over.grossCents ?? 2000,
      commissionCents: 400,
      feeCents: 0,
      method: (over.method ?? 'YAPE') as never,
      status: (over.status ?? 'DEBT') as never,
      failureReason:
        over.failureReason === undefined ? 'yape_insufficient_funds' : over.failureReason,
      payerRef: over.payerRef ?? null,
      retries: over.retries ?? 3,
      createdAt: over.createdAt ?? new Date('2026-06-01T00:00:00Z'),
      externalUid: over.externalUid ?? null,
      checkoutUrl: over.checkoutUrl ?? null,
      deepLink: over.deepLink ?? null,
      qrCode: over.qrCode ?? null,
      cip: over.cip ?? null,
    },
  });
  return { id, tripId };
}

async function capturedEvents(paymentId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateId: paymentId, eventType: 'payment.captured' },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

// Cada test parte de un estado limpio (los asserts sobre outbox/orden dependen de no arrastrar filas).
beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.cancellationPenalty.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('getDebtForPassenger (deuda del pasajero)', () => {
  it('sin deuda → hasDebt=false, total 0, lista vacía', async () => {
    await seedPayment({ status: 'CAPTURED', failureReason: null });
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(false);
    expect(out.totalCents).toBe(0);
    expect(out.debts).toEqual([]);
  });

  it('con dos deudas → hasDebt=true, total sumado, orden por createdAt asc (más antigua primero) y shape', async () => {
    const older = await seedPayment({
      amountCents: 1000,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const newer = await seedPayment({
      amountCents: 2500,
      createdAt: new Date('2026-06-05T00:00:00Z'),
    });
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(3500);
    expect(out.debts.map((d) => d.tripId)).toEqual([older.tripId, newer.tripId]); // orden asc
    expect(out.debts[0]).toMatchObject({
      paymentId: older.id,
      tripId: older.tripId,
      amountCents: 1000,
      reason: 'yape_insufficient_funds',
    });
    expect(typeof out.debts[0]?.createdAt).toBe('string'); // ISO
  });

  it('NO devuelve la deuda de OTRO pasajero (filtra por passengerId)', async () => {
    await seedPayment({ passengerId: OTHER });
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(false);
  });

  it('cada deuda lleva kind=DEBT', async () => {
    await seedPayment();
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.debts).toHaveLength(1);
    expect(out.debts[0]?.kind).toBe('DEBT');
  });

  it('PENDING con checkout vivo (deepLink) → PENDING_ACTION; NO cuenta como deuda (hasDebt=false, total 0)', async () => {
    const p = await seedPayment({
      status: 'PENDING',
      failureReason: null,
      externalUid: '01KTHPQ6RPD4J2P7NWFKGRNPJG',
      deepLink: 'yapeapp:oneshot/abc',
    });
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(false);
    expect(out.totalCents).toBe(0);
    expect(out.debts).toHaveLength(1);
    expect(out.debts[0]).toMatchObject({
      paymentId: p.id,
      tripId: p.tripId,
      kind: 'PENDING_ACTION',
    });
  });

  it('PENDING SIN checkout (efectivo / on-file sin medios) → NO accionable, se excluye', async () => {
    await seedPayment({ status: 'PENDING', method: 'CASH', failureReason: null });
    await seedPayment({ status: 'PENDING', failureReason: null, externalUid: 'uid-x' }); // sin medios
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.debts).toEqual([]);
    expect(out.hasDebt).toBe(false);
  });

  it('mezcla DEBT + PENDING_ACTION → DEBT primero, total SOLO de la deuda, hasDebt=true', async () => {
    const debt = await seedPayment({
      amountCents: 2300,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const pending = await seedPayment({
      amountCents: 3600,
      status: 'PENDING',
      failureReason: null,
      createdAt: new Date('2026-06-02T00:00:00Z'),
      externalUid: '01KTHPQ6RPD4J2P7NWFKGRNPJG',
      deepLink: 'yapeapp:oneshot/xyz',
    });
    const out = await makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
    ).getDebtForPassenger(PAX);
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(2300); // SOLO la deuda; el PENDING_ACTION (3600) no suma
    expect(out.debts.map((d) => d.kind)).toEqual(['DEBT', 'PENDING_ACTION']);
    expect(out.debts.map((d) => d.tripId)).toEqual([debt.tripId, pending.tripId]);
  });
});

describe('retryCharge (saldar deuda)', () => {
  it('sandbox: DEBT → re-cobro al riel → CAPTURED (payerRef no termina en 0000)', async () => {
    const { id } = await seedPayment({ payerRef: '51999111222' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('CAPTURED');
    expect(await capturedEvents(id)).toHaveLength(1);
  });

  it('sandbox: el riel vuelve a rechazar (payerRef 0000) → de vuelta a DEBT', async () => {
    const { id } = await seedPayment({ payerRef: '51900000000' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('DEBT');
  });

  it('idempotente: sobre un cobro YA CAPTURED → no-op (no re-cobra, devuelve estado)', async () => {
    const { id } = await seedPayment({ status: 'CAPTURED', failureReason: null });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('CAPTURED');
    expect(await prisma.outboxEvent.findMany({})).toHaveLength(0); // no emitió nada nuevo
  });

  it('concurrencia: el status-guard transaccional (updateMany where status=DEBT) deja pasar a UNO solo', async () => {
    const { id } = await seedPayment({ payerRef: '51999111222' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    const [a, b] = await Promise.all([svc.retryCharge(id), svc.retryCharge(id)]);
    expect(a.id).toBe(b.id);
    expect(await capturedEvents(id)).toHaveLength(1); // un solo cobro, no doble
    const final = await svc.getPayment(id);
    expect(final.status).toBe('CAPTURED');
  });

  it('PENDING (cobro/re-cobro en curso) → no-op idempotente (devuelve estado, no re-cobra)', async () => {
    const { id } = await seedPayment({ status: 'PENDING' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('PENDING');
    expect(await prisma.outboxEvent.findMany({})).toHaveLength(0); // no disparó otro cobro
  });

  it('FAILED (cobro externo cancelado, estado terminal) → InvalidStateError', async () => {
    const { id } = await seedPayment({ status: 'FAILED' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    await expect(svc.retryCharge(id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('CASH: una deuda en efectivo NO se re-cobra al riel → InvalidStateError', async () => {
    const { id } = await seedPayment({ method: 'CASH' });
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    await expect(svc.retryCharge(id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('pago inexistente → NotFoundError', async () => {
    const svc = makeService(
      new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' }),
      'sandbox',
    );
    await expect(svc.retryCharge(uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('prontopaga: DEBT → re-cobro asíncrono → PENDING con checkout nuevo (urlPay/qr)', async () => {
    const { id } = await seedPayment();
    const gateway = new SandboxPaymentGateway({
      confirmDelayMs: 0,
      declineSuffix: '0000',
      pendingExternal: true,
      webhookSecret: 'sec',
    });
    const svc = makeService(gateway, 'prontopaga');
    const out = await svc.retryCharge(id);
    expect(out.status).toBe('PENDING'); // espera webhook/poll
    expect(out.checkoutUrl ?? out.qrCode).toBeTruthy(); // checkout nuevo persistido
  });
});
