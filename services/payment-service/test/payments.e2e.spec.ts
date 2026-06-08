/**
 * E2E con Postgres REAL (testcontainers) — sin mocks de DB (CLAUDE regla 1).
 * Cubre los dos invariantes críticos del dominio:
 *   1) Cobro idempotente: doble-submit con la misma dedupKey produce UN solo pago.
 *   2) Transición a DEBT: tras agotar los reintentos contra el riel, el pago queda en DEBT
 *      y se encola payment.failed (willRetry=false) en el outbox.
 * El riel se ejerce con el adapter SANDBOX real (declina de forma determinista por payerRef).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { PromotionsService } from '../src/promotions/promotions.service';
import { deriveTripChargeDedupKey } from '../src/payments/payment.policy';
import { SandboxPaymentGateway } from '../src/ports/gateway/sandbox.gateway';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { Env } from '../src/config/env.schema';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let service: PaymentsService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();

  const config = new ConfigService<Env, true>({
    VEO_PAYMENT_MODE: 'sandbox',
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1, // backoff mínimo para el test
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
  });
  const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const promotions = new PromotionsService(prismaService);
  // En modo sandbox no se consultan afiliaciones; un resolver no-op alcanza para la regresión.
  const affiliations = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;
  service = new PaymentsService(prismaService, gateway, affiliations, promotions, config);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

describe('Cobro idempotente con Postgres real (BR-P01/P04 + idempotencia)', () => {
  it('doble-submit secuencial con la misma dedupKey produce UN solo pago capturado', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);

    const first = await service.charge({
      tripId,
      grossCents: 2000,
      tipCents: 300,
      method: 'YAPE',
      payerRef: '51999111222', // no termina en 0000 → confirma
      dedupKey,
    });
    const second = await service.charge({
      tripId,
      grossCents: 2000,
      tipCents: 300,
      method: 'YAPE',
      payerRef: '51999111222',
      dedupKey,
    });

    expect(first.id).toBe(second.id);
    expect(first.status).toBe('CAPTURED');
    // Comisión BR-P04: 20% de 2000 = 400; propina fuera de comisión; total cobrado 2300.
    expect(first.commissionCents).toBe(400);
    expect(first.feeCents).toBe(400);
    expect(first.amountCents).toBe(2300);

    const rows = await prisma.payment.findMany({ where: { dedupKey } });
    expect(rows).toHaveLength(1);

    const captured = await prisma.outboxEvent.findMany({
      where: { aggregateId: first.id, eventType: 'payment.captured' },
    });
    expect(captured).toHaveLength(1);
  });

  it('doble-submit concurrente con la misma dedupKey produce UN solo pago', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const input = {
      tripId,
      grossCents: 1500,
      method: 'YAPE' as const,
      payerRef: '51988777666',
      dedupKey,
    };

    const [a, b] = await Promise.all([service.charge(input), service.charge(input)]);
    expect(a.id).toBe(b.id);

    const rows = await prisma.payment.findMany({ where: { dedupKey } });
    expect(rows).toHaveLength(1);

    const final = await service.getPayment(a.id);
    expect(final.status).toBe('CAPTURED');
  });
});

describe('chargeFromTripCompleted respeta el método del VIAJE (fix bug PLATA)', () => {
  it('viaje CASH → Payment method=CASH y status=PENDING (espera confirmación bilateral, NO captura)', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);

    const payment = await service.chargeFromTripCompleted({
      tripId,
      grossCents: 2000,
      dedupKey,
      method: 'CASH',
    });

    expect(payment.method).toBe('CASH');
    // El efectivo NO se cobra contra el riel: queda PENDING hasta la confirmación bilateral (BR-P03).
    expect(payment.status).toBe('PENDING');
    expect(payment.capturedAt).toBeNull();

    // No debe haber emitido payment.captured (no se capturó nada todavía).
    const captured = await prisma.outboxEvent.findMany({
      where: { aggregateId: payment.id, eventType: 'payment.captured' },
    });
    expect(captured).toHaveLength(0);
  });

  it('viaje YAPE → Payment method=YAPE y status=CAPTURED (sandbox confirma)', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);

    const payment = await service.chargeFromTripCompleted({
      tripId,
      grossCents: 2000,
      dedupKey,
      method: 'YAPE',
    });

    expect(payment.method).toBe('YAPE');
    // YAPE va contra el riel sandbox (sin payerRef no termina en 0000 → confirma determinista).
    expect(payment.status).toBe('CAPTURED');
    expect(payment.capturedAt).not.toBeNull();
  });

  it('evento SIN método (legacy) → cae al defaultMethod del env (YAPE en este config)', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);

    const payment = await service.chargeFromTripCompleted({
      tripId,
      grossCents: 2000,
      dedupKey,
      // method ausente: simula un trip.completed viejo sin paymentMethod en el envelope.
    });

    // Fallback: DEFAULT_PAYMENT_METHOD=YAPE en el ConfigService del test.
    expect(payment.method).toBe('YAPE');
    expect(payment.status).toBe('CAPTURED');
  });
});

describe('Transición a DEBT tras 3 fallos del riel (BR-P02)', () => {
  it('agota reintentos y deja el pago en DEBT con payment.failed willRetry=false', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);

    const payment = await service.charge({
      tripId,
      grossCents: 3000,
      method: 'PLIN',
      payerRef: '51900000000', // termina en 0000 → el sandbox declina de forma determinista
      dedupKey,
    });

    expect(payment.status).toBe('DEBT');
    expect(payment.retries).toBe(3);
    expect(payment.failureReason).toBe('INSUFFICIENT_FUNDS');

    const failed = await prisma.outboxEvent.findMany({
      where: { aggregateId: payment.id, eventType: 'payment.failed' },
    });
    expect(failed).toHaveLength(1);
    const envelope = failed[0]?.envelope as { payload?: { willRetry?: boolean; tripId?: string } };
    expect(envelope.payload?.willRetry).toBe(false);
    expect(envelope.payload?.tripId).toBe(tripId);
  });
});
