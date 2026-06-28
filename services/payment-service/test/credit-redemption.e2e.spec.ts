/**
 * Redención de crédito de referido en el cobro (Ola 2A · Lote B) · E2E con Postgres REAL (testcontainers) —
 * NO se mockea la DB en un crítico de DINERO (CLAUDE). El crédito reduce lo que paga el pasajero (mismo
 * trato que la promo: la plataforma lo absorbe, comisión SOBRE el bruto), decrementa el saldo y se guarda
 * en `payment.credit_cents` aparte del descuento de promo. Idempotente por `credit:dedupKey`.
 *
 * Se cobra con CASH (crea el Payment PENDING sin tocar el gateway) para aislar la aritmética del crédito.
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
import { CreditService } from '../src/credit/credit.service';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import { deriveTripChargeDedupKey } from '../src/payments/payment.policy';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;
let svc: PaymentsService;
let credit: CreditService;

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

async function seedCredit(userId: string, cents: number): Promise<void> {
  await prisma.userCredit.create({ data: { userId, balanceCents: cents } });
}
async function balance(userId: string): Promise<number> {
  return (await prisma.userCredit.findUnique({ where: { userId } }))?.balanceCents ?? 0;
}
function chargeCashTrip(tripId: string) {
  return svc.chargeFromTripCompleted({
    tripId,
    grossCents: 2000,
    dedupKey: deriveTripChargeDedupKey(tripId),
    method: 'CASH',
    userId: PAX,
  });
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
  credit = new CreditService(prismaService);
  svc = new PaymentsService(
    prismaService,
    gateway,
    noAffiliation,
    noPromos,
    makeConfig() as never,
    credit,
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.userCreditEntry.deleteMany({});
  await prisma.userCredit.deleteMany({});
});

describe('Redención de crédito en el cobro (Lote B · dinero en céntimos)', () => {
  it('aplica el crédito al payable: amount = gross − credit, comisión sobre el bruto, saldo decrementado', async () => {
    await seedCredit(PAX, 1500);
    const trip = uuidv7();
    const payment = await chargeCashTrip(trip);

    expect(payment.creditCents).toBe(1500);
    expect(payment.discountCents).toBe(0); // sin promo
    expect(payment.amountCents).toBe(500); // 2000 − 1500
    expect(payment.commissionCents).toBe(400); // 20% SOBRE el bruto 2000 (la plataforma absorbe el crédito)
    expect(await balance(PAX)).toBe(0); // saldo gastado
  });

  it('topa el crédito a la tarifa: con saldo > gross, solo aplica gross (amount=0) y deja el resto', async () => {
    await seedCredit(PAX, 5000);
    const payment = await chargeCashTrip(uuidv7());

    expect(payment.creditCents).toBe(2000); // topado a gross
    expect(payment.amountCents).toBe(0);
    expect(await balance(PAX)).toBe(3000); // 5000 − 2000
  });

  it('sin saldo: no aplica crédito, cobro normal', async () => {
    const payment = await chargeCashTrip(uuidv7());
    expect(payment.creditCents).toBe(0);
    expect(payment.amountCents).toBe(2000);
  });

  it('idempotente: re-cobrar el MISMO viaje (misma dedupKey) no re-gasta el saldo', async () => {
    await seedCredit(PAX, 1500);
    const trip = uuidv7();
    const first = await chargeCashTrip(trip);
    const second = await chargeCashTrip(trip); // re-entrega del trip.completed

    expect(second.id).toBe(first.id); // mismo Payment (corta en `existing`)
    expect(second.creditCents).toBe(1500);
    expect(await balance(PAX)).toBe(0); // decrementado UNA sola vez
  });

  it('spendForCharge directo es idempotente por chargeDedupKey (devuelve el mismo monto, gasta una vez)', async () => {
    await seedCredit(PAX, 1000);
    const dedup = `trip-${uuidv7()}`;
    const a = await credit.spendForCharge({
      userId: PAX,
      maxApplicableCents: 800,
      chargeDedupKey: dedup,
    });
    const b = await credit.spendForCharge({
      userId: PAX,
      maxApplicableCents: 800,
      chargeDedupKey: dedup,
    });
    expect(a).toBe(800);
    expect(b).toBe(800); // mismo monto, no re-gasta
    expect(await balance(PAX)).toBe(200); // 1000 − 800, una sola vez
  });
});
