/**
 * EFECTIVO · cierre del dominó · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en un
 * crítico de dinero (CLAUDE). Reemplaza al antiguo cash-domino.spec.ts (fake Prisma en memoria).
 *
 * chargeFromTripCompleted con cashCollected (el efectivo se confirma AL TERMINAR el viaje):
 *   - CASH + cashCollected=true → Payment CASH PENDING + CashConfirmation driverConfirmed=true +
 *     payment.cash_pending (push). NO captura (falta el pasajero).
 *   - luego confirmCash('passenger') → ambos true → CAPTURED + payment.captured.
 *   - CASH SIN cashCollected → bilateral normal (driverConfirmed=false, sin cash_pending).
 *   - pasajero confirmó ANTES de existir el Payment → al crear → CAPTURA directo.
 *   - DIGITAL (YAPE) con cashCollected → se ignora (va por el riel).
 *   - idempotencia: reprocesar el mismo trip.completed no duplica la confirmación ni recaptura.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import { deriveTripChargeDedupKey } from '../src/payments/payment.policy';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const TRIP = '0192f8a0-0000-7000-8000-0000000000c1';
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;
let svc: PaymentsService;

const noPromos = {
  redeemPromo: async () => ({ discountCents: 0 }),
} as unknown as PromotionsService;
const noAffiliation = {
  resolveActiveWalletUid: async () => null,
} as unknown as AffiliationsService;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    VEO_PAYMENT_MODE: 'sandbox',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

function chargeCash(opts: { cashCollected?: boolean } = {}) {
  return svc.chargeFromTripCompleted({
    tripId: TRIP,
    grossCents: 2000,
    dedupKey: deriveTripChargeDedupKey(TRIP),
    method: 'CASH',
    userId: PAX,
    cashCollected: opts.cashCollected,
  });
}

async function outboxTypes(): Promise<string[]> {
  const rows = await prisma.outboxEvent.findMany({});
  return rows.map((r) => r.eventType);
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
  svc = new PaymentsService(prismaService, gateway, noAffiliation, noPromos, makeConfig() as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.cashConfirmation.deleteMany({});
  await prisma.cancellationPenalty.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('chargeFromTripCompleted · EFECTIVO con cashCollected (driver confirma al terminar)', () => {
  it('CASH + cashCollected=true → PENDING + CashConfirmation driverConfirmed=true + emite cash_pending', async () => {
    const payment = await chargeCash({ cashCollected: true });

    expect(payment.method).toBe('CASH');
    expect(payment.status).toBe('PENDING'); // NO captura: falta el pasajero
    const conf = await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } });
    expect(conf?.driverConfirmed).toBe(true);
    expect(conf?.passengerConfirmed).toBe(false);
    const types = await outboxTypes();
    expect(types).toContain('payment.cash_pending'); // push al pasajero
    expect(types).not.toContain('payment.captured'); // NO se capturó todavía
  });

  it('luego el PASAJERO confirma → ambos true → CAPTURED + payment.captured', async () => {
    const payment = await chargeCash({ cashCollected: true });
    const out = await svc.confirmCash(payment.id, PAX, 'passenger', true);

    expect(out.status).toBe('CAPTURED');
    expect(out.driverConfirmed).toBe(true);
    expect(out.passengerConfirmed).toBe(true);
    const final = await svc.getPayment(payment.id);
    expect(final.status).toBe('CAPTURED');
    expect(await outboxTypes()).toContain('payment.captured');
  });

  it('CASH SIN cashCollected → bilateral normal: driverConfirmed=false, NO emite cash_pending', async () => {
    const payment = await chargeCash(); // sin cashCollected

    expect(payment.status).toBe('PENDING');
    // Ninguna CashConfirmation creada (el conductor no confirmó nada todavía).
    expect(await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } })).toBeNull();
    expect(await outboxTypes()).not.toContain('payment.cash_pending');
  });

  it('caso raro: el pasajero confirmó ANTES de existir el Payment → al crear con cashCollected → CAPTURA directo', async () => {
    // El pasajero confirmó primero: sembramos la CashConfirmation passengerConfirmed=true.
    await prisma.cashConfirmation.create({
      data: { id: uuidv7(), tripId: TRIP, driverConfirmed: false, passengerConfirmed: true },
    });

    const payment = await chargeCash({ cashCollected: true });

    const final = await svc.getPayment(payment.id);
    expect(final.status).toBe('CAPTURED'); // ambos true → captura inmediata
    const types = await outboxTypes();
    expect(types).toContain('payment.captured');
    expect(types).not.toContain('payment.cash_pending'); // ya capturó: no pide confirmación
  });

  it('DIGITAL (YAPE) con cashCollected=true → se IGNORA: no toca CashConfirmation ni emite cash_pending', async () => {
    await svc.chargeFromTripCompleted({
      tripId: TRIP,
      grossCents: 2000,
      dedupKey: deriveTripChargeDedupKey(TRIP),
      method: 'YAPE', // sandbox sin payerRef declinante → captura por el riel
      userId: PAX,
      cashCollected: true, // ruido para digital
    });

    expect(await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } })).toBeNull();
    expect(await outboxTypes()).not.toContain('payment.cash_pending');
  });

  it('idempotente: reprocesar el MISMO trip.completed no duplica la confirmación ni recaptura', async () => {
    const p = await chargeCash({ cashCollected: true });
    await svc.confirmCash(p.id, PAX, 'passenger', true);
    const capturesBefore = (await outboxTypes()).filter((t) => t === 'payment.captured').length;

    // Redelivery del MISMO trip.completed: charge devuelve el Payment existente (dedupKey UNIQUE). Como ya
    // está CAPTURED (no PENDING), NO se re-aplica la confirmación del conductor ni se re-emite nada.
    await chargeCash({ cashCollected: true });

    const capturesAfter = (await outboxTypes()).filter((t) => t === 'payment.captured').length;
    expect(capturesAfter).toBe(capturesBefore); // sin doble captura
    const final = await svc.getPayment(p.id);
    expect(final.status).toBe('CAPTURED');
  });
});

describe('REGLA DE BORDE · un CASH PENDING con driverConfirmed (sin confirmar el pasajero) NO bloquea ni es accionable', () => {
  it('queda PENDING pero NO es DEBT (no bloquea pedir viajes) y NO es PENDING_ACTION (sin checkout)', async () => {
    // El conductor cobró y confirmó al terminar; el pasajero NUNCA confirma → el Payment queda PENDING.
    const payment = await chargeCash({ cashCollected: true });
    expect(payment.status).toBe('PENDING');
    expect(
      (await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } }))?.driverConfirmed,
    ).toBe(true);

    // El gate de DEBT y la query de PENDING_ACTION NO lo agarran: un CASH sin external_uid no es accionable
    // (no tiene checkout) y no es deuda (el conductor ya cobró en mano; no es deuda del pasajero).
    const debt = await svc.getDebtForPassenger(PAX);
    expect(debt.hasDebt).toBe(false); // NO bloquea POST /trips
    expect(debt.totalCents).toBe(0);
    expect(debt.debts).toEqual([]); // ni DEBT ni PENDING_ACTION
  });
});
