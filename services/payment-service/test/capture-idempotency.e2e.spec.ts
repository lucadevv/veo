/**
 * E2E con Postgres REAL (testcontainers) — la captura de un pago es un invariante de DINERO: un
 * `payment.captured` duplicado = doble push "pago confirmado" al pasajero y riesgo para cualquier
 * consumer downstream no-idempotente. Sin mock de DB (CLAUDE: pagos NO se mockean).
 *
 * Verifica el guard ATÓMICO (CAS) de captureSuccess/captureCash: el estado va en el WHERE del
 * updateMany, así dos capturas CONCURRENTES del MISMO pago (dos entregas del webhook en paralelo, o
 * la confirmación bilateral de efectivo driver+passenger en la misma ventana) → exactamente UNA
 * matchea PENDING→CAPTURED y emite el evento; la otra ve count=0 → no-op. La idempotencia secuencial
 * ya la cubre applyWebhookResult (corta si el pago está CAPTURED); esto cierra la ventana concurrente.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type { PaymentGateway } from '../src/ports/gateway/payment-gateway.port';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let payments: PaymentsService;

// Identidades FIJAS del pago sembrado: confirmCash valida que el caller sea el party (anti-IDOR),
// así que el seed debe usar estos mismos ids como passengerId/driverId del pago.
const PASSENGER = '0192f8a0-0000-7000-8000-0000000000aa';
const DRIVER = '0192f8a0-0000-7000-8000-0000000000bb';

/** Config mínima: el capture path solo lee estas claves del constructor. */
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

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  // captureSuccess/captureCash/confirmCash/applyWebhookResult NO tocan gateway/affiliations/promotions → stubs.
  const gateway = {} as unknown as PaymentGateway;
  const affiliations = {} as unknown as AffiliationsService;
  const promotions = {} as unknown as PromotionsService;
  payments = new PaymentsService(
    prismaService,
    gateway,
    affiliations,
    promotions,
    makeConfig() as never,
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

/** Inserta un pago PENDING con los campos mínimos requeridos por el modelo. */
async function seedPendingPayment(
  method: 'YAPE' | 'CASH',
): Promise<{ id: string; tripId: string }> {
  const id = uuidv7();
  const tripId = uuidv7();
  await prisma.payment.create({
    data: {
      id,
      tripId,
      passengerId: PASSENGER,
      driverId: DRIVER,
      dedupKey: `trip-${tripId}`,
      amountCents: 2000,
      grossCents: 2000,
      commissionCents: 400,
      feeCents: 0,
      method,
      externalUid: `uid-${id}`,
      status: 'PENDING',
    },
  });
  return { id, tripId };
}

async function capturedEvents(paymentId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateId: paymentId, eventType: 'payment.captured' },
  });
}

describe('Captura de pago · guard atómico CAS (sin payment.captured duplicado)', () => {
  it('webhook: dos CONFIRMED CONCURRENTES del mismo pago → exactamente UNA captura (un solo evento)', async () => {
    const { id } = await seedPendingPayment('YAPE');

    // Carrera real contra Postgres: dos entregas del webhook procesadas en paralelo. Sin el CAS, ambas
    // leen PENDING y encolan payment.captured (TOCTOU). Con el CAS, solo una matchea PENDING→CAPTURED.
    await Promise.all([
      payments.applyWebhookResult({ paymentId: id, externalUid: `uid-${id}`, status: 'CONFIRMED' }),
      payments.applyWebhookResult({ paymentId: id, externalUid: `uid-${id}`, status: 'CONFIRMED' }),
    ]);

    const stored = await prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('CAPTURED');
    expect(await capturedEvents(id)).toHaveLength(1);
  });

  it('efectivo: confirmación bilateral COMPLETA entregada dos veces en paralelo → un solo evento', async () => {
    const { id, tripId } = await seedPendingPayment('CASH');
    // Estado "ambas partes ya confirmaron": dos confirmCash concurrentes ven both-true y van ambas a
    // captureCash. El CAS garantiza una sola captura (espeja la carrera driver+passenger en la misma ventana).
    await prisma.cashConfirmation.create({
      data: { id: uuidv7(), tripId, driverConfirmed: true, passengerConfirmed: true },
    });

    await Promise.all([
      payments.confirmCash(id, PASSENGER, 'passenger', true),
      payments.confirmCash(id, DRIVER, 'driver', true),
    ]);

    const stored = await prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('CAPTURED');
    expect(await capturedEvents(id)).toHaveLength(1);
  });
});
