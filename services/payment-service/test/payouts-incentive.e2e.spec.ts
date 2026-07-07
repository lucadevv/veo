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
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7, NotFoundError } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PayoutsService } from '../src/payouts/payouts.service';
import { SandboxPayoutGateway } from '../src/ports/gateway/sandbox-payout.gateway';
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
  // El cron solo AGREGA (PENDING) — no toca el gateway. Igual lo inyectamos (real sandbox) para los tests
  // de desembolso de este suite. confirmSync:false ⇒ el disburse queda SUBMITTED (async), como en prod.
  const gateway = new SandboxPayoutGateway({ rejectSeed: 0, confirmSync: false });
  return new PayoutsService(prismaService, redis as never, gateway, makeConfig() as never);
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
  await prisma.driverCredit.deleteMany({});
  await prisma.driverDebt.deleteMany({});
});

describe('PayoutsService.runPayouts · el bono de incentivo entra al Payout (fix payout-link)', () => {
  it('bono completado en ventana → Payout PENDING lo incluye, ligado al progress, paidAt AÚN null (cron solo agrega)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    // ADR-015 §3: el cron ya NO nace PROCESSED — crea PENDING (la plata no se movió aún).
    expect(summary.pending).toBe(1);
    expect(summary.totalAmountCents).toBe(6000);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(6000); // bono NETO
    expect(payout.grossCents).toBe(0); // no infla el bruto
    expect(payout.commissionCents).toBe(0); // ni la comisión
    expect(payout.status).toBe('PENDING');
    expect(payout.processedAt).toBeNull();

    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
    // Hueco 5 cerrado: el bono se LIGA al payout pero NO se marca pagado hasta el desembolso confirmado.
    expect(progress.paidAt).toBeNull();
    expect(progress.paidInPayoutId).toBe(payout.id);
  });

  it('re-correr runPayouts NO duplica el Payout ni re-liga el bono (idempotencia del cron)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const { redis } = makeRedis();
    const svc = makeService(redis);

    await svc.runPayouts(PERIOD_START, PERIOD_END);
    const second = await svc.runPayouts(PERIOD_START, PERIOD_END);
    expect(second.pending).toBe(0); // ya existía el Payout del período

    const payouts = await prisma.payout.findMany({ where: { driverId } });
    expect(payouts).toHaveLength(1); // UNIQUE(driverId, periodStart, periodEnd) sin duplicar

    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
    expect(progress.paidAt).toBeNull(); // el cron no marca pagado; el bono sigue ligado al payout PENDING
    expect(progress.paidInPayoutId).toBe(payouts[0]!.id);
  });

  it('driver BAJO el mínimo liquidable → su bono NO se marca pagado (paidAt sigue null)', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(3000); // 3000 < 5000 (mínimo) → no liquida
    const progressId = await seedCompletedProgress(incentiveId, driverId, 3000, IN_WINDOW);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);
    expect(summary.pending).toBe(0);

    expect(await prisma.payout.findMany({ where: { driverId } })).toHaveLength(0);
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
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
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
    expect(progress.paidInPayoutId).toBe(payout.id);
  });

  it('back-pay POR ARRASTRE: un bono HISTÓRICO (completedAt fuera de la ventana) SÍ se paga en el run', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(7000);
    // completedAt en ABRIL, muy anterior al período [18–25 mayo): sin arrastre NO se barrería.
    const progressId = await seedCompletedProgress(incentiveId, driverId, 7000, HISTORIC);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);
    expect(summary.pending).toBe(1);
    expect(summary.totalAmountCents).toBe(7000);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(7000);
    expect(payout.status).toBe('PENDING');
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
    // El bono histórico SÍ entra (back-pay por arrastre), ligado al payout PENDING; paidAt se marca al confirmar.
    expect(progress.paidAt).toBeNull();
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
    expect(summary.pending).toBe(0);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.status).toBe('HELD');
    expect(payout.amountCents).toBe(6000); // el bono está dentro del monto retenido
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({
      where: { id: progressId },
    });
    expect(progress.paidInPayoutId).toBe(payout.id); // ligado al Payout (se libera al resolver el review)
  });

  it('FIX doble-pago: un bono YA ligado a un Payout PENDING no-confirmado NO se re-recolecta en el run del período siguiente', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    // Bono histórico (abril): entra por back-pay-por-arrastre en cualquier run cuyo `end` sea posterior.
    const progressId = await seedCompletedProgress(incentiveId, driverId, 6000, HISTORIC);
    const { redis } = makeRedis();
    const svc = makeService(redis);

    // Run del período 1 [11–18 may): crea el Payout PENDING con el bono ligado (paidAt AÚN null, cron no confirma).
    const p1Start = new Date('2026-05-11T00:00:00.000Z');
    const p1End = new Date('2026-05-18T00:00:00.000Z');
    const s1 = await svc.runPayouts(p1Start, p1End);
    expect(s1.pending).toBe(1);
    const p1 = await prisma.payout.findFirstOrThrow({ where: { driverId } });

    // Run del período 2 [18–25 may): el bono sigue paidAt:null (p1 no confirmado) PERO ya está ligado a p1 y su
    // monto ya está congelado ahí. Sin el guard `paidInPayoutId:null`, el back-pay lo re-recolectaría y lo
    // bancaría en un SEGUNDO Payout → doble-pago. Con el guard: no se re-recolecta (el driver no tiene otras
    // ganancias en p2 → no nace un 2º payout).
    const s2 = await svc.runPayouts(PERIOD_START, PERIOD_END);
    expect(s2.pending).toBe(0); // NO se crea un 2º Payout con el bono re-recolectado

    const payouts = await prisma.payout.findMany({ where: { driverId } });
    expect(payouts).toHaveLength(1); // el bono vive en UN solo Payout, no en dos
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidInPayoutId).toBe(p1.id); // sigue ligado al ORIGINAL, no re-ligado al del período 2
  });
});

/** Inserta un DriverCredit PENDIENTE (comisión CASH revertida cuya deuda ya se neteó) para el conductor. */
async function seedPendingCredit(driverId: string, amountCents: number): Promise<string> {
  const id = uuidv7();
  await prisma.driverCredit.create({
    data: { id, driverId, tripId: uuidv7(), amountCents, sourcePaymentId: uuidv7(), status: 'PENDING' },
  });
  return id;
}

describe('PayoutsService.runPayouts · credit-back de comisión CASH revertida (gate MEDIA #4)', () => {
  it('crédito PENDIENTE → se SUMA al neto del Payout y queda APPLIED ligado al payout', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    // El bono es la ganancia que mete al conductor en el run; el crédito se suma encima (la plataforma se lo debe).
    await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const creditId = await seedPendingCredit(driverId, 400);
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    expect(summary.totalAmountCents).toBe(6400); // bono 6000 + crédito 400
    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(6400);
    expect(payout.debtAppliedCents).toBe(-400); // neto NEGATIVO = crédito a favor del conductor

    const credit = await prisma.driverCredit.findUniqueOrThrow({ where: { id: creditId } });
    expect(credit.status).toBe('APPLIED');
    expect(credit.appliedInPayoutId).toBe(payout.id); // ligado al payout (conciliación)
  });

  it('el crédito da MARGEN para netear una deuda entera este período (ganancia + crédito − deuda)', async () => {
    const driverId = uuidv7();
    // Ganancia (bono) 6000 > MIN_CENTS (5000) para que el conductor entre al run; el neto queda chico igual.
    const incentiveId = await seedIncentive(6000);
    await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW); // ganancia 6000
    await seedPendingCredit(driverId, 400); // crédito 400
    await prisma.driverDebt.create({
      data: {
        id: uuidv7(),
        driverId,
        tripId: uuidv7(),
        paymentId: uuidv7(),
        amountCents: 6300, // sin el crédito el borde quedaría PENDING (carry-forward); con él se salda entera
        status: 'PENDING',
      },
    });
    const { redis } = makeRedis();

    await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(100); // 6000 − 6300 + 400
    const debts = await prisma.driverDebt.findMany({ where: { driverId, status: 'PENDING' } });
    expect(debts).toHaveLength(0); // la deuda se saldó ENTERA (el crédito dio margen), sin carry-forward
  });

  it('re-correr runPayouts NO re-aplica el crédito (ya APPLIED) ni duplica el payout', async () => {
    const driverId = uuidv7();
    const incentiveId = await seedIncentive(6000);
    await seedCompletedProgress(incentiveId, driverId, 6000, IN_WINDOW);
    const creditId = await seedPendingCredit(driverId, 400);
    const { redis } = makeRedis();
    const svc = makeService(redis);

    await svc.runPayouts(PERIOD_START, PERIOD_END);
    await svc.runPayouts(PERIOD_START, PERIOD_END); // 2do run: el driver ya está liquidado → skip

    const payouts = await prisma.payout.findMany({ where: { driverId } });
    expect(payouts).toHaveLength(1); // sin payout duplicado
    const credit = await prisma.driverCredit.findUniqueOrThrow({ where: { id: creditId } });
    expect(credit.status).toBe('APPLIED'); // aplicado UNA sola vez (no se re-suma en el 2do run)
  });
});

describe('PayoutsService.runPayouts · credit-only (#25): pagar al conductor sin ganancia lo que se le debe', () => {
  it('crédito ≥ mínimo y SIN ganancia digital → payout STANDALONE del crédito, credit APPLIED', async () => {
    const driverId = uuidv7();
    const creditId = await seedPendingCredit(driverId, 6000); // ≥ MIN_CENTS (5000); NO se siembra ganancia
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    expect(summary.totalAmountCents).toBe(6000);
    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(6000); // el crédito entero
    expect(payout.grossCents).toBe(0); // no hubo viaje/ganancia
    expect(payout.commissionCents).toBe(0);
    const credit = await prisma.driverCredit.findUniqueOrThrow({ where: { id: creditId } });
    expect(credit.status).toBe('APPLIED');
    expect(credit.appliedInPayoutId).toBe(payout.id);
  });

  it('crédito BAJO el mínimo y sin ganancia → NO paga (carry-forward), el crédito sigue PENDING', async () => {
    const driverId = uuidv7();
    const creditId = await seedPendingCredit(driverId, 3000); // < MIN_CENTS (5000)
    const { redis } = makeRedis();

    const summary = await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    expect(summary.totalAmountCents).toBe(0);
    const payouts = await prisma.payout.findMany({ where: { driverId } });
    expect(payouts).toHaveLength(0); // no se crea payout de polvo
    const credit = await prisma.driverCredit.findUniqueOrThrow({ where: { id: creditId } });
    expect(credit.status).toBe('PENDING'); // espera a acumular o a que el conductor vuelva a ganar
  });

  it('crédito neteado contra deuda PENDING: solo paga si el NETO alcanza el mínimo', async () => {
    const driverId = uuidv7();
    await seedPendingCredit(driverId, 8000); // crédito 8000
    await prisma.driverDebt.create({
      data: {
        id: uuidv7(),
        driverId,
        tripId: uuidv7(),
        paymentId: uuidv7(),
        amountCents: 1000, // deuda 1000 → neto 7000 ≥ mínimo → paga el neto
        status: 'PENDING',
      },
    });
    const { redis } = makeRedis();

    await makeService(redis).runPayouts(PERIOD_START, PERIOD_END);

    const payout = await prisma.payout.findFirstOrThrow({ where: { driverId } });
    expect(payout.amountCents).toBe(7000); // 8000 crédito − 1000 deuda
    const debts = await prisma.driverDebt.findMany({ where: { driverId, status: 'PENDING' } });
    expect(debts).toHaveLength(0); // la deuda se saldó contra el crédito (SETTLED)
  });
});

describe('PayoutsService.getPayout · hueco #1 (detalle con breakdown abierto por FK)', () => {
  /** Inserta un Payout PROCESADO con su NETO firmado (debtAppliedCents) + traza del desembolso. */
  async function seedPayout(debtAppliedCents = 0): Promise<string> {
    const id = uuidv7();
    await prisma.payout.create({
      data: {
        id,
        driverId: uuidv7(),
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        grossCents: 10000,
        commissionCents: 2000,
        amountCents: 8300,
        debtAppliedCents,
        status: 'PROCESSED',
        dedupKey: `payout-disburse:${id}`,
        externalRef: 'rail-ref-1',
      },
    });
    return id;
  }

  it('abre el NETO en creditBack + debtSettled sumando SOLO lo ligado por FK a ESTE payout', async () => {
    const svc = makeService(makeRedis().redis);
    const payoutId = await seedPayout(-300); // 200 deuda − 500 crédito = −300 (a favor del conductor)
    const driverId = uuidv7();
    // crédito APLICADO a este payout (appliedInPayoutId)
    await prisma.driverCredit.create({
      data: {
        id: uuidv7(), driverId, tripId: uuidv7(), amountCents: 500, sourcePaymentId: uuidv7(),
        status: 'APPLIED', appliedInPayoutId: payoutId, appliedAt: new Date(),
      },
    });
    // deuda SALDADA en este payout (settledInPayoutId)
    await prisma.driverDebt.create({
      data: {
        id: uuidv7(), driverId, tripId: uuidv7(), paymentId: uuidv7(), amountCents: 200,
        status: 'SETTLED', settledInPayoutId: payoutId, settledAt: new Date(),
      },
    });
    // RUIDO: un crédito PENDING (no ligado a ningún payout) NO debe contarse en el detalle
    await prisma.driverCredit.create({
      data: { id: uuidv7(), driverId, tripId: uuidv7(), amountCents: 999, sourcePaymentId: uuidv7(), status: 'PENDING' },
    });

    const detail = await svc.getPayout(payoutId);
    expect(detail.creditBackCents).toBe(500);
    expect(detail.debtSettledCents).toBe(200);
    expect(detail.debtAppliedCents).toBe(-300);
    expect(detail.debtAppliedCents).toBe(detail.debtSettledCents - detail.creditBackCents); // invariante
    expect(detail.dedupKey).toBe(`payout-disburse:${payoutId}`);
    expect(detail.externalRef).toBe('rail-ref-1');
  });

  it('sin credit/debt ligados → creditBackCents y debtSettledCents en 0', async () => {
    const svc = makeService(makeRedis().redis);
    const payoutId = await seedPayout();
    const detail = await svc.getPayout(payoutId);
    expect(detail.creditBackCents).toBe(0);
    expect(detail.debtSettledCents).toBe(0);
  });

  it('payout inexistente → NotFoundError', async () => {
    const svc = makeService(makeRedis().redis);
    await expect(svc.getPayout(uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });
});
