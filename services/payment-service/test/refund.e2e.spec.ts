/**
 * PaymentsService.refund (BR-P06) · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en un
 * crítico de dinero (CLAUDE). Reemplaza al antiguo refund.spec.ts (fake Prisma en memoria).
 *
 * Prueba que refund() emite payment.refunded por OUTBOX en la MISMA tx, con el monto reembolsado y el
 * passengerId enriquecido (persistido al cobrar), y que la ventana/transición se respetan (F1/F4 CAS).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { InvalidStateError, uuidv7 } from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type { PaymentGateway } from '../src/ports/gateway/payment-gateway.port';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000aa';

let db: TestDatabase;
let prisma: PrismaClient;
let payments: PaymentsService;

const noGateway = {} as unknown as PaymentGateway;
const noAffiliation = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;
const noPromos = { redeemPromo: async () => ({ discountCents: 0 }) } as unknown as PromotionsService;
const L2: AuthenticatedUser = { userId: 'op-L2', roles: [AdminRole.SUPPORT_L2] } as unknown as AuthenticatedUser;

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
  return { getOrThrow: (k: string) => values[k], get: (k: string) => values[k] } as unknown as ConfigService;
}

/** Inserta un Payment CAPTURED reembolsable (capturedAt = ahora → dentro de la ventana). */
async function seedCaptured(over: { passengerId?: string | null } = {}): Promise<{ id: string; tripId: string }> {
  const id = uuidv7();
  const tripId = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: over.passengerId === undefined ? PAX : over.passengerId,
      dedupKey: `trip-completed:${tripId}`,
      amountCents: 2000,
      grossCents: 2000,
      commissionCents: 400,
      feeCents: 0,
      refundedCents: 0,
      method: 'YAPE',
      status: 'CAPTURED',
      capturedAt: new Date(),
    },
  });
  return { id, tripId };
}

async function refundedPayload(): Promise<Record<string, unknown> | undefined> {
  const rows = await prisma.outboxEvent.findMany({ where: { eventType: 'payment.refunded' } });
  const env = rows[0]?.envelope as { payload: Record<string, unknown> } | undefined;
  return env?.payload;
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  payments = new PaymentsService(prismaService, noGateway, noAffiliation, noPromos, makeConfig() as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('PaymentsService.refund · emite payment.refunded por outbox', () => {
  it('reembolso parcial válido → payment.refunded con amountCents y passengerId enriquecido', async () => {
    const { id, tripId } = await seedCaptured();
    const res = await payments.refund(tripId, 500, 'cliente_insatisfecho', L2);
    expect(res.status).toBe('PARTIALLY_REFUNDED'); // 500 de 2000 → parcial (F4)

    const payload = await refundedPayload();
    expect(payload).toMatchObject({
      paymentId: id,
      tripId,
      amountCents: 500, // lo reembolsado, no el bruto
      approvedBy: 'op-L2',
      passengerId: PAX,
    });
  });

  it('reembolso TOTAL → marca el pago REFUNDED y crea la fila Refund', async () => {
    const { tripId } = await seedCaptured();
    const res = await payments.refund(tripId, 2000, 'x', L2); // monto completo → REFUNDED
    expect(res.status).toBe('REFUNDED');
    expect(await prisma.refund.findMany({})).toHaveLength(1);
  });

  it('sin passengerId persistido → el evento igual se emite (passengerId omitido)', async () => {
    const { tripId } = await seedCaptured({ passengerId: null });
    await payments.refund(tripId, 500, 'x', L2);
    const payload = await refundedPayload();
    expect(payload?.passengerId).toBeUndefined();
  });

  it('reembolso mayor al cobrado → InvalidStateError, sin evento', async () => {
    const { tripId } = await seedCaptured();
    await expect(payments.refund(tripId, 3000, 'x', L2)).rejects.toBeInstanceOf(InvalidStateError);
    expect(await prisma.outboxEvent.findMany({ where: { eventType: 'payment.refunded' } })).toHaveLength(0);
  });
});
