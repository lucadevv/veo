/**
 * EFECTIVO · cierre del dominó · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en un
 * crítico de dinero (CLAUDE). Reemplaza al antiguo cash-domino.spec.ts (fake Prisma en memoria).
 *
 * chargeTripFare con cashCollected (el efectivo se confirma AL TERMINAR el viaje):
 *   DECISIÓN DEL DUEÑO (2026-07-14): UNA sola confirmación (el conductor tiene la plata en mano). El
 *   pasajero YA NO confirma — solo ve un recibo informativo. Sin doble paso bilateral ni cash_pending.
 *   - CASH + cashCollected=true → CAPTURA directo + CashConfirmation ambos true + payment.captured
 *     (NO cash_pending, NO espera al pasajero).
 *   - CASH SIN cashCollected → NO captura (driverConfirmed=false, sin cash_pending).
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
import { PaymentsRepository } from '../src/payments/payments.repository';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import { deriveTripChargeDedupKey } from '../src/payments/payment.policy';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const TRIP = '0192f8a0-0000-7000-8000-0000000000c1';
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';
const DRV = '0192f8a0-0000-7000-8000-0000000000bb';

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
    REFUND_IDEMPOTENCY_WINDOW_MINUTES: 15,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

function chargeCash(opts: { cashCollected?: boolean; driverId?: string } = {}) {
  return svc.chargeTripFare({
    tripId: TRIP,
    grossCents: 2000,
    dedupKey: deriveTripChargeDedupKey(TRIP),
    method: 'CASH',
    userId: PAX,
    // driverId solo cuando el test lo necesita (confirmCash anti-IDOR). Omitirlo por default evita acumular
    // deuda de comisión del conductor en los tests de captura, que no la testean.
    driverId: opts.driverId,
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
  svc = new PaymentsService(new PaymentsRepository(prismaService), gateway, noAffiliation, noPromos, makeConfig() as never);
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

describe('chargeTripFare · EFECTIVO con cashCollected (driver confirma al terminar)', () => {
  it('CASH + cashCollected=true → CAPTURED directo (conductor captura, sin doble confirmación) + payment.captured', async () => {
    // DECISIÓN DEL DUEÑO (2026-07-14): una sola confirmación (el conductor tiene la plata en mano). El
    // pasajero YA NO confirma → el efectivo se captura al toque, sin cash_pending ni espera bilateral.
    const payment = await chargeCash({ cashCollected: true });

    expect(payment.method).toBe('CASH');
    expect(payment.status).toBe('CAPTURED'); // captura directo con la confirmación del conductor
    const conf = await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } });
    expect(conf?.driverConfirmed).toBe(true);
    expect(conf?.passengerConfirmed).toBe(true); // el conductor confirma por ambos
    const types = await outboxTypes();
    expect(types).toContain('payment.captured');
    expect(types).not.toContain('payment.cash_pending'); // el pasajero ya NO confirma → sin push de confirmación
  });

  it('el pago queda CAPTURED con la SOLA confirmación del conductor (el pasajero ya no necesita confirmar)', async () => {
    const payment = await chargeCash({ cashCollected: true });
    const final = await svc.getPayment(payment.id);
    expect(final.status).toBe('CAPTURED'); // sin un segundo paso del pasajero
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
    await svc.chargeTripFare({
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

describe('REGLA DE BORDE · un CASH PENDING SIN resolver (el conductor aún no confirmó) NO bloquea ni es accionable', () => {
  it('queda PENDING (driverConfirmed=false) y NO es DEBT ni PENDING_ACTION (sin checkout)', async () => {
    // Cash creado pero el conductor todavía no tocó "Sí, recibí" ni "No cobré" → driverConfirmed=false.
    // Mientras esté sin resolver NO debe bloquear al pasajero (no es deuda todavía) ni ser accionable por
    // él (no tiene checkout: el efectivo se salda en mano, no por un rail). Lo resuelve el conductor.
    const payment = await chargeCash({});
    expect(payment.status).toBe('PENDING');
    expect(
      (await prisma.cashConfirmation.findUnique({ where: { tripId: TRIP } }))?.driverConfirmed ??
        false,
    ).toBe(false);

    const debt = await svc.getDebtForPassenger(PAX);
    expect(debt.hasDebt).toBe(false); // NO bloquea POST /trips
    expect(debt.totalCents).toBe(0);
    expect(debt.debts).toEqual([]); // ni DEBT ni PENDING_ACTION
  });
});

describe('"No cobré" del conductor (confirmed=false) → DEUDA DEL PASAJERO (decisión del dueño 2026-07-14)', () => {
  it('CASH PENDING + confirmCash(driver,false) → status DEBT + entra al debt gate + emite payment.failed', async () => {
    // El conductor reporta que el pasajero no pagó. El viaje ocurrió → es deuda del pasajero, no una disputa
    // a soporte ni una pérdida del conductor. El Payment pasa a DEBT (reusa markDebt) → lo agarra el debt gate.
    const payment = await chargeCash({ driverId: DRV }); // PENDING sin resolver, con conductor asignado
    await prisma.outboxEvent.deleteMany({}); // aislar el evento de la falla del ruido de la creación

    const result = await svc.confirmCash(payment.id, DRV, 'driver', false);
    expect(result.status).toBe('DEBT');

    const after = await svc.getPayment(payment.id);
    expect(after.status).toBe('DEBT');
    expect(after.failureReason).toBe('CASH_NOT_COLLECTED');

    // El gate del pasajero AHORA lo bloquea: no puede pedir otro viaje hasta regularizar.
    const debt = await svc.getDebtForPassenger(PAX);
    expect(debt.hasDebt).toBe(true);
    expect(debt.totalCents).toBe(2000);
    expect(debt.debts.some((d) => d.tripId === TRIP && d.kind === 'DEBT')).toBe(true);

    // Emite payment.failed (willRetry=false) con passengerId → notification puede empujar el push al pasajero.
    const failed = await prisma.outboxEvent.findFirst({ where: { eventType: 'payment.failed' } });
    expect(failed).not.toBeNull();
    const envelope = failed?.envelope as { payload: Record<string, unknown> };
    expect(envelope.payload.reason).toBe('CASH_NOT_COLLECTED');
    expect(envelope.payload.willRetry).toBe(false);
    expect(envelope.payload.passengerId).toBe(PAX);
  });
});
