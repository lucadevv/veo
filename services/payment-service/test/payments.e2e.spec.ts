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
import { uuidv7, NotFoundError, InvalidStateError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type Redis from 'ioredis';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import { PayoutsService } from '../src/payouts/payouts.service';
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
let payouts: PayoutsService;

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
    PAYOUT_MIN_CENTS: 1000,
    PAYOUT_STEPUP_CENTS: 500000,
  });
  const gateway = new SandboxPaymentGateway({ confirmDelayMs: 0, declineSuffix: '0000' });
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const promotions = new PromotionsService(prismaService);
  // En modo sandbox no se consultan afiliaciones; un resolver no-op alcanza para la regresión.
  const affiliations = { resolveActiveWalletUid: async () => null } as unknown as AffiliationsService;
  service = new PaymentsService(prismaService, gateway, affiliations, promotions, config);
  // PayoutsService con Redis falso (el set de flagged/lock no es el store del dinero; la DB sí es real).
  const fakeRedis = {
    sismember: async () => 0,
    sadd: async () => 1,
    set: async () => 'OK',
  } as unknown as Redis;
  payouts = new PayoutsService(prismaService, fakeRedis, config);
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
    // S5: status = estado del REFUND. El sandbox reembolsa síncrono (ACCEPTED) → COMPLETED.
    expect(first.status).toBe('COMPLETED');
    expect((await service.getPayment(captured.id)).status).toBe('REFUNDED');

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

    // Parcial 1: 1000 de 3000 → el pago queda PARTIALLY_REFUNDED, refundedCents=1000, refundedAt null.
    // S5: el status devuelto es el del REFUND (COMPLETED: el sandbox confirma síncrono).
    const r1 = await service.refund(tripId, 1000, 'parcial-1', operator());
    expect(r1.status).toBe('COMPLETED');
    let p = await prisma.payment.findUnique({ where: { id: captured.id } });
    expect(p?.status).toBe('PARTIALLY_REFUNDED');
    expect(p?.refundedCents).toBe(1000);
    expect(p?.refundedAt).toBeNull();

    // Parcial 2: 2000 → completa 3000 → el pago pasa a REFUNDED, refundedAt seteado.
    const r2 = await service.refund(tripId, 2000, 'parcial-2', operator());
    expect(r2.status).toBe('COMPLETED');
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

  it('una penalidad PENDING BLOQUEA el gate de deuda: getDebtForPassenger → hasDebt + monto + kind (F2.2)', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();

    // Antes de la penalidad: el pasajero no tiene nada bloqueante.
    const before = await service.getDebtForPassenger(passengerId);
    expect(before.hasDebt).toBe(false);
    expect(before.totalCents).toBe(0);

    const res = await service.recordCancellationPenalty({
      tripId,
      passengerId,
      driverId: uuidv7(),
      penaltyCents: 800,
      reason: 'no_show',
    });

    const after = await service.getDebtForPassenger(passengerId);
    expect(after.hasDebt).toBe(true); // la penalidad bloquea el gate igual que una deuda
    expect(after.totalCents).toBe(800); // y suma al monto bloqueante
    const item = after.debts.find((d) => d.kind === 'CANCELLATION_PENALTY');
    expect(item).toBeDefined();
    expect(item?.penaltyId).toBe(res.penaltyId);
    expect(item?.paymentId).toBeUndefined(); // una penalidad no es un Payment
    expect(item?.tripId).toBe(tripId);
    expect(item?.amountCents).toBe(800);
  });

  it('una penalidad COLLECTED/WAIVED ya NO bloquea (solo PENDING cuenta)', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const res = await service.recordCancellationPenalty({ tripId, passengerId, penaltyCents: 500 });
    // Saldada fuera de banda → el gate se libera.
    await prisma.cancellationPenalty.update({
      where: { id: res.penaltyId },
      data: { status: 'COLLECTED', collectedAt: new Date() },
    });
    const after = await service.getDebtForPassenger(passengerId);
    expect(after.hasDebt).toBe(false);
    expect(after.debts.some((d) => d.kind === 'CANCELLATION_PENALTY')).toBe(false);
  });
});

describe('Saldar penalidad de cancelación por el rail (F2.3: settle → COLLECTED + libera el gate)', () => {
  it('saldar una penalidad PENDING captura el Payment de liquidación y la pasa a COLLECTED + libera el gate', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const driverId = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId, passengerId, driverId, penaltyCents: 800 });

    // Gate bloqueado antes de saldar.
    expect((await service.getDebtForPassenger(passengerId)).hasDebt).toBe(true);

    const payment = await service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' });

    // El Payment de liquidación capturó (sandbox confirma) y NO lleva driverId (no entra al payout por aquí).
    expect(payment.status).toBe('CAPTURED');
    expect(payment.cancellationPenaltyId).toBe(rec.penaltyId);
    expect(payment.driverId).toBeNull();
    expect(payment.amountCents).toBe(800);
    expect(payment.commissionCents).toBe(0);
    expect(payment.dedupKey).toBe(`cancellation-penalty:${rec.penaltyId}`);

    // La penalidad quedó COLLECTED con collectedAt.
    const penalty = await prisma.cancellationPenalty.findUnique({ where: { id: rec.penaltyId } });
    expect(penalty?.status).toBe('COLLECTED');
    expect(penalty?.collectedAt).not.toBeNull();

    // Gate liberado.
    const after = await service.getDebtForPassenger(passengerId);
    expect(after.hasDebt).toBe(false);

    // Dominó: UN evento payment.cancellation_penalty_collected (notification + payout del conductor).
    const collected = await prisma.outboxEvent.findMany({
      where: { aggregateId: rec.penaltyId, eventType: 'payment.cancellation_penalty_collected' },
    });
    expect(collected).toHaveLength(1);
    const payload = (collected[0]!.envelope as { payload: Record<string, unknown> }).payload;
    expect(payload.settlementPaymentId).toBe(payment.id);
    expect(payload.driverCompensationCents).toBe(400); // floor(0.5 × 800)
  });

  it('saldar dos veces (doble-tap) es idempotente: UN Payment de liquidación y UN solo evento collected', async () => {
    const passengerId = uuidv7();
    const tripId = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId, passengerId, penaltyCents: 600 });

    const first = await service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' });
    const second = await service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' });

    expect(second.id).toBe(first.id); // devuelve el MISMO Payment de liquidación
    const payments = await prisma.payment.findMany({ where: { cancellationPenaltyId: rec.penaltyId } });
    expect(payments).toHaveLength(1);
    const collected = await prisma.outboxEvent.findMany({
      where: { aggregateId: rec.penaltyId, eventType: 'payment.cancellation_penalty_collected' },
    });
    expect(collected).toHaveLength(1); // captura idempotente → un solo evento
  });

  it('anti-IDOR: saldar una penalidad de OTRO pasajero → NotFoundError (anti-enumeración)', async () => {
    const owner = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId: uuidv7(), passengerId: owner, penaltyCents: 500 });
    await expect(
      service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId: uuidv7(), method: 'YAPE' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // No se creó ningún Payment de liquidación.
    const payments = await prisma.payment.findMany({ where: { cancellationPenaltyId: rec.penaltyId } });
    expect(payments).toHaveLength(0);
  });

  it('una penalidad WAIVED no se puede pagar → InvalidStateError', async () => {
    const passengerId = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId: uuidv7(), passengerId, penaltyCents: 500 });
    await prisma.cancellationPenalty.update({ where: { id: rec.penaltyId }, data: { status: 'WAIVED' } });
    await expect(
      service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('CASH no aplica a una penalidad → InvalidStateError (se paga digital)', async () => {
    const passengerId = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId: uuidv7(), passengerId, penaltyCents: 500 });
    await expect(
      service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'CASH' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Compensación de penalidad al conductor en el payout (F2.3b: collectEarnings)', () => {
  it('una penalidad COLLECTED acredita driverCompensationCents NETO al payout del conductor', async () => {
    const driverId = uuidv7();
    const passengerId = uuidv7();
    const rec = await service.recordCancellationPenalty({
      tripId: uuidv7(),
      passengerId,
      driverId,
      penaltyCents: 8000, // comp = floor(0.5 × 8000) = 4000
    });
    await service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' });

    // Ventana que cubre el collectedAt (~ahora). runPayouts agrega y crea el Payout del período.
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 3_600_000);
    await payouts.runPayouts(start, end);

    const payout = await prisma.payout.findFirst({ where: { driverId } });
    expect(payout).not.toBeNull();
    // La compensación entra NETA: amount = 4000; el bruto/comisión quedan en 0 (no es tarifa de viaje).
    expect(payout?.amountCents).toBe(4000);
    expect(payout?.grossCents).toBe(0);
    expect(payout?.commissionCents).toBe(0);
    expect(payout?.status).toBe('PROCESSED');
  });

  it('una penalidad SIN conductor (driverCompensation 0) no crea payout para nadie', async () => {
    const passengerId = uuidv7();
    const rec = await service.recordCancellationPenalty({ tripId: uuidv7(), passengerId, penaltyCents: 6000 });
    await service.settleCancellationPenalty({ penaltyId: rec.penaltyId, passengerId, method: 'YAPE' });

    const penalty = await prisma.cancellationPenalty.findUnique({ where: { id: rec.penaltyId } });
    expect(penalty?.driverId).toBeNull();
    expect(penalty?.driverCompensationCents).toBe(0);
    // El Payment de liquidación lleva driverId=NULL → tampoco entra como ganancia de viaje. Nada que pagar.
    const settlement = await prisma.payment.findUnique({ where: { dedupKey: `cancellation-penalty:${rec.penaltyId}` } });
    expect(settlement?.driverId).toBeNull();
  });
});
