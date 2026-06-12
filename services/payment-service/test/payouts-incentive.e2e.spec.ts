/**
 * PayoutsService.runPayouts · liquidación del BONO de incentivo (fix payout-link) · E2E con Postgres
 * REAL (testcontainers) — NO se mockea la DB en un crítico de dinero (CLAUDE §"No mockear DB").
 *
 * El bug: `incentive.completed` era un evento huérfano. El bono se concedía en IncentiveProgress
 * (rewardGrantedCents) pero `collectEarnings` solo sumaba payments CAPTURED + penalidades, así que el
 * bono JAMÁS entraba a un Payout: el conductor lo veía completado y la plata no llegaba.
 *
 * Este suite verifica, contra DB real:
 *  - el bono entra al Payout.amountCents (NETO, sin inflar bruto/comisión);
 *  - el IncentiveProgress queda marcado paidAt!=null + paidInPayoutId = payout.id;
 *  - re-correr runPayouts NO duplica el Payout ni re-paga el bono (idempotencia, CAS paidAt:null);
 *  - un driver BAJO el mínimo liquidable NO queda con el bono marcado-pagado (el peor bug);
 *  - back-pay POR ARRASTRE: un bono HISTÓRICO (completedAt fuera de la ventana) SÍ se paga en el run.
 *
 * Redis es un doble en memoria (no es el crítico de dinero acá; el lock/flag sí se ejercitan): expone
 * `set`/`del` (withDistributedLock) y `sismember`/`sadd`/`srem` (retención de drivers flaggeados).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PayoutsService } from '../src/payouts/payouts.service';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

// Período de liquidación de la prueba: [2026-05-18, 2026-05-25).
const PERIOD_START = new Date('2026-05-18T00:00:00.000Z');
const PERIOD_END = new Date('2026-05-25T00:00:00.000Z');
const IN_WINDOW = new Date('2026-05-20T12:00:00.000Z'); // completedAt dentro de la ventana
const HISTORIC = new Date('2026-04-10T12:00:00.000Z'); // completedAt MUY anterior (back-pay)

const MIN_CENTS = 5000;
const STEPUP_CENTS = 500_000;

let db: TestDatabase;
let prisma: PrismaClient;

function makeConfig(): ConfigService {
  const values: Record<string, number> = {
    PAYOUT_MIN_CENTS: MIN_CENTS,
    PAYOUT_STEPUP_CENTS: STEPUP_CENTS,
  };
  return { getOrThrow: (k: string) => values[k] } as unknown as ConfigService;
}

/** Redis en memoria: lock distribuido (set NX / del) + set de drivers flaggeados (sismember/sadd/srem). */
function makeRedis(): { redis: unknown; flagged: Set<string> } {
  const locks = new Set<string>();
  const flagged = new Set<string>();
  const redis = {
    set: async (key: string, _v: string, _ex: 'EX', _ttl: number, _nx: 'NX') => {
      if (locks.has(key)) return null;
      locks.add(key);
      return 'OK';
    },
    del: async (key: string) => (locks.delete(key) ? 1 : 0),
    sismember: async (_k: string, m: string) => (flagged.has(m) ? 1 : 0),
    sadd: async (_k: string, m: string) => (flagged.add(m) ? 1 : 0),
    srem: async (_k: string, m: string) => (flagged.delete(m) ? 1 : 0),
  };
  return { redis, flagged };
}

function makeService(redis: unknown): PayoutsService {
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  return new PayoutsService(prismaService, redis as never, makeConfig() as never);
}

/** Inserta un Incentive META_VIAJES con su bono. Una fila por test (active, sin caducidad). */
async function seedIncentive(rewardCents: number): Promise<string> {
  const id = uuidv7();
  await prisma.incentive.create({
    data: {
      id,
      type: 'META_VIAJES',
      title: 'Meta semanal',
      description: 'Completá 20 viajes',
      targetTrips: 20,
      rewardCents,
      active: true,
    },
  });
  return id;
}

/** Inserta un IncentiveProgress COMPLETADO no-pagado (completedAt set, rewardGrantedCents > 0, paidAt:null). */
async function seedCompletedProgress(
  incentiveId: string,
  driverId: string,
  rewardGrantedCents: number,
  completedAt: Date,
): Promise<string> {
  const id = uuidv7();
  await prisma.incentiveProgress.create({
    data: {
      id,
      incentiveId,
      driverId,
      tripsCompleted: 20,
      completedAt,
      rewardGrantedCents,
    },
  });
  return id;
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

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.payout.deleteMany({});
  await prisma.incentiveProgress.deleteMany({});
  await prisma.incentiveTripCredit.deleteMany({});
  await prisma.incentive.deleteMany({});
});

describe('PayoutsService.runPayouts · el bono de incentivo entra al Payout (fix payout-link)', () => {
  it('bono completado en ventana → Payout.amountCents lo incluye y el progress queda pagado', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    expect(summary.processed).toBe(1);
    expect(summary.totalAmountCents).toBe(6000);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(6000); // bono NETO
    expect(payout.grossCents).toBe(0); // no infla el bruto
    expect(payout.commissionCents).toBe(0); // ni la comisión
    expect(payout.status).toBe('PROCESSED');

    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).not.toBeNull();
    expect(progress.paidInPayoutId).toBe(payout.id);
  });

  it('re-correr runPayouts NO duplica el Payout ni re-paga el bono (idempotencia, CAS paidAt:null)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const { redis } = makeRedis();
    const svc = makeService(redis);

    await svc.runPayouts(PERIOD_START, PERIOD_END);
    const firstPaidAt = (await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } })).paidAt;

    const second = await svc.runPayouts(PERIOD_START, PERIOD_END);
    expect(second.processed).toBe(0); // ya existía el Payout del período

    const payouts = await prisma.payout.findMany({ where: { driverId } });
    expect(payouts).toHaveLength(1); // UNIQUE(driverId, periodStart, periodEnd) sin duplicar

    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).toEqual(firstPaidAt); // no se re-marcó (mismo timestamp)
    expect(progress.paidInPayoutId).toBe(payouts[0]!.id);
  });

  it('driver BAJO el mínimo liquidable → su bono NO se marca pagado (paidAt sigue null)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(3000); // 3000 < 5000 (mínimo) → no liquida
    const progressId = await seedCompletedProgress(incentiveId, driverId, 3000, IN_WINDOW);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);
    expect(summary.processed).toBe(0);

    expect(await prisma.payout.findMany({ where: { driverId } })).toHaveLength(0);
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).toBeNull(); // el peor bug evitado: marcado-pagado-pero-no-pagado
    expect(progress.paidInPayoutId).toBeNull();
  });

  it('el bono se SUMA al cobro del viaje del mismo driver y entra junto al Payout', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(2000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 2000, IN_WINDOW);
    // Cobro capturado en ventana: bruto 5000 − comisión 1000 = 4000 neto; +2000 bono = 6000 total.
    await prisma.payment.create({
      data: {
        id: uuidv7(),
        tripId: uuidv7(),
        dedupKey: `trip:${uuidv7()}`,
        driverId,
        amountCents: 5000,
        grossCents: 5000,
        commissionCents: 1000,
        feeCents: 0,
        refundedCents: 0,
        method: 'YAPE',
        status: 'CAPTURED',
        capturedAt: IN_WINDOW,
      },
    });
    const { redis } = makeRedis();

    await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.grossCents).toBe(5000); // solo la tarifa
    expect(payout.commissionCents).toBe(1000);
    expect(payout.amountCents).toBe(6000); // 4000 neto viaje + 2000 bono
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidInPayoutId).toBe(payout.id);
  });

  it('back-pay POR ARRASTRE: un bono HISTÓRICO (completedAt fuera de la ventana) SÍ se paga en el run', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(7000);
    // completedAt en ABRIL, muy anterior al período [18–25 mayo): sin arrastre NO se barrería.
    const progressId = await seedCompletedProgress(incentiveId, driverId, 7000, HISTORIC);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);
    expect(summary.processed).toBe(1);
    expect(summary.totalAmountCents).toBe(7000);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(7000);
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).not.toBeNull();
    expect(progress.paidInPayoutId).toBe(payout.id);
  });

  it('driver flaggeado → Payout HELD con el bono dentro; el progress se marca (el bono se libera al resolver)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const { redis, flagged } = makeRedis();
    flagged.add(driverId);

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);
    expect(summary.held).toBe(1);
    expect(summary.processed).toBe(0);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.status).toBe('HELD');
    expect(payout.amountCents).toBe(6000); // el bono está dentro del monto retenido
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidInPayoutId).toBe(payout.id); // ligado al Payout (se libera al resolver el review)
  });
});
