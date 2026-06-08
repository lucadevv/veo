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
import type { AuthenticatedUser } from '@veo/auth';
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
    CANCELLATION_DRIVER_SHARE: 0.5,
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

describe('Refund: status-guard transaccional (F1, idempotencia financiera #3)', () => {
  it('el claim CAPTURED→REFUNDED es atómico: dos transacciones concurrentes → exactamente UNO gana (no doble plata)', async () => {
    // Reproduce la carrera real de prod (2 requests / 2 pods leen el pago CAPTURED y ambos intentan
    // reembolsar). El row-lock de Postgres serializa el `updateMany where status='CAPTURED'`: uno reclama
    // (count=1), el otro re-evalúa el WHERE ya commiteado (REFUNDED) y obtiene count=0. Resultado SIEMPRE
    // [0,1]. Con un `update` incondicional por id (el bug original) ambos contarían 1 → doble reembolso.
    // DETERMINISTA — no depende del scheduling in-process (que serializa el read-then-act de refund()).
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const captured = await service.charge({
      tripId,
      grossCents: 2000,
      method: 'YAPE',
      payerRef: '51999333444',
      dedupKey,
    });
    expect(captured.status).toBe('CAPTURED');

    const claim = () =>
      prisma.$transaction((tx) =>
        tx.payment
          .updateMany({
            where: { id: captured.id, status: 'CAPTURED' },
            data: { status: 'REFUNDED', refundedAt: new Date() },
          })
          .then((r) => r.count),
      );
    const counts = await Promise.all([claim(), claim()]);
    expect([...counts].sort()).toEqual([0, 1]);

    const final = await service.getPayment(captured.id);
    expect(final.status).toBe('REFUNDED');
  });

  it('refund() rechaza un 2do reembolso del mismo cobro → 1 solo Refund + 1 solo evento payment.refunded', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const captured = await service.charge({
      tripId,
      grossCents: 2000,
      method: 'YAPE',
      payerRef: '51999555666',
      dedupKey,
    });
    expect(captured.status).toBe('CAPTURED');
    expect(captured.amountCents).toBe(2000); // ≤ umbral L2 (3000) → no exige rol L2

    const operator = { userId: uuidv7(), roles: [] } as unknown as AuthenticatedUser;
    const first = await service.refund(tripId, 2000, 'ok', operator);
    expect(first.status).toBe('REFUNDED');

    // 2do refund del mismo viaje: ya no hay CAPTURED → rechazado, sin crear otro Refund ni emitir otro evento.
    await expect(service.refund(tripId, 2000, 'duplicado', operator)).rejects.toThrow();

    const refunds = await prisma.refund.findMany({ where: { paymentId: captured.id } });
    expect(refunds).toHaveLength(1);
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: captured.id, eventType: 'payment.refunded' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('Refund PARCIAL (F4: PARTIALLY_REFUNDED + el conductor no pierde su payout)', () => {
  const operator = (): AuthenticatedUser =>
    ({ userId: uuidv7(), roles: [] }) as unknown as AuthenticatedUser;

  it('parcial → PARTIALLY_REFUNDED y acumula refundedCents; al completar el monto → REFUNDED', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const captured = await service.charge({
      tripId,
      grossCents: 3000,
      method: 'YAPE',
      payerRef: '51999777888',
      dedupKey,
    });
    expect(captured.status).toBe('CAPTURED');
    expect(captured.amountCents).toBe(3000);

    // Parcial 1: 1000 de 3000 → PARTIALLY_REFUNDED, refundedCents=1000, refundedAt aún null.
    const r1 = await service.refund(tripId, 1000, 'parcial-1', operator());
    expect(r1.status).toBe('PARTIALLY_REFUNDED');
    let p = await prisma.payment.findUnique({ where: { id: captured.id } });
    expect(p?.status).toBe('PARTIALLY_REFUNDED');
    expect(p?.refundedCents).toBe(1000);
    expect(p?.refundedAt).toBeNull();

    // Parcial 2: 2000 → completa 3000 → REFUNDED, refundedAt seteado.
    const r2 = await service.refund(tripId, 2000, 'parcial-2', operator());
    expect(r2.status).toBe('REFUNDED');
    p = await prisma.payment.findUnique({ where: { id: captured.id } });
    expect(p?.status).toBe('REFUNDED');
    expect(p?.refundedCents).toBe(3000);
    expect(p?.refundedAt).not.toBeNull();

    // Dos Refund persistidos, dos eventos payment.refunded (uno por parcial).
    const refunds = await prisma.refund.findMany({ where: { paymentId: captured.id } });
    expect(refunds).toHaveLength(2);
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: captured.id, eventType: 'payment.refunded' },
    });
    expect(events).toHaveLength(2);
  });

  it('rechaza un refund que excede el saldo reembolsable (amount − ya reembolsado)', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const captured = await service.charge({
      tripId,
      grossCents: 2000,
      method: 'YAPE',
      payerRef: '51999111000',
      dedupKey,
    });
    await service.refund(tripId, 1500, 'parcial', operator()); // saldo restante: 500
    await expect(service.refund(tripId, 600, 'excede', operator())).rejects.toThrow(/excede el saldo/);
    const p = await prisma.payment.findUnique({ where: { id: captured.id } });
    expect(p?.refundedCents).toBe(1500); // el rechazado no movió el acumulador
  });

  it('un cobro PARTIALLY_REFUNDED SIGUE contando para el payout (mismo filtro que collectEarnings)', async () => {
    const tripId = uuidv7();
    const dedupKey = deriveTripChargeDedupKey(tripId);
    const captured = await service.charge({
      tripId,
      grossCents: 4000,
      method: 'YAPE',
      payerRef: '51999222111',
      dedupKey,
    });
    await service.refund(tripId, 1000, 'goodwill', operator()); // parcial → PARTIALLY_REFUNDED

    // Invariante del fix F4: collectEarnings filtra status IN (CAPTURED, PARTIALLY_REFUNDED).
    const eligible = await prisma.payment.findMany({
      where: { id: captured.id, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
    });
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.grossCents).toBe(4000); // base de comisión del conductor intacta
  });
});

describe('CancellationPenalty (F2: penalidad de cancelación con split conductor/plataforma)', () => {
  it('registra PENDING con el split (driver 50% / plataforma 50%), emite evento + idempotente por tripId', async () => {
    const tripId = uuidv7();
    const passengerId = uuidv7();
    const driverId = uuidv7();

    const res = await service.recordCancellationPenalty({
      tripId,
      passengerId,
      driverId,
      penaltyCents: 600,
      reason: 'no_show',
    });
    expect(res.status).toBe('PENDING');

    const row = await prisma.cancellationPenalty.findUnique({ where: { tripId } });
    expect(row?.status).toBe('PENDING');
    expect(row?.penaltyCents).toBe(600);
    expect(row?.driverCompensationCents).toBe(300); // floor(0.5 × 600)
    expect(row?.platformCents).toBe(300);
    expect(row?.driverId).toBe(driverId);

    // Dominó: un solo evento payment.cancellation_penalty_recorded (notification avisa al pasajero).
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: row!.id, eventType: 'payment.cancellation_penalty_recorded' },
    });
    expect(events).toHaveLength(1);

    // Idempotente: reprocesar el MISMO evento (trip_id @unique) no duplica ni emite otro evento.
    const again = await service.recordCancellationPenalty({ tripId, passengerId, driverId, penaltyCents: 600 });
    expect(again.penaltyId).toBe(res.penaltyId);
    const all = await prisma.cancellationPenalty.findMany({ where: { tripId } });
    expect(all).toHaveLength(1);
    const events2 = await prisma.outboxEvent.findMany({
      where: { aggregateId: row!.id, eventType: 'payment.cancellation_penalty_recorded' },
    });
    expect(events2).toHaveLength(1);
  });

  it('sin conductor → la penalidad va ENTERA a la plataforma (driverCompensation 0)', async () => {
    const tripId = uuidv7();
    const res = await service.recordCancellationPenalty({
      tripId,
      passengerId: uuidv7(),
      penaltyCents: 400,
    });
    expect(res.status).toBe('PENDING');
    const row = await prisma.cancellationPenalty.findUnique({ where: { tripId } });
    expect(row?.driverCompensationCents).toBe(0);
    expect(row?.platformCents).toBe(400);
    expect(row?.driverId).toBeNull();
  });
});
