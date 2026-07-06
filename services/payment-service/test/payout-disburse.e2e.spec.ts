/**
 * Ciclo de vida del DESEMBOLSO money-OUT (ADR-015 sub-lote 2b) · E2E con Postgres REAL (testcontainers) —
 * NO se mockea la DB en un crítico de dinero (CLAUDE §"No mockear DB"). Espejo del e2e del CHARGE money-IN.
 *
 * Cubre, contra DB real, los caminos del §3/§4/§7/§8:
 *  - disburse: PENDING → PROCESSING emite payout.processing + persiste dedupKey + externalRef.
 *  - confirmación: PROCESSING → PROCESSED marca paidAt del incentivo + emite payout.processed.
 *  - rechazo: PROCESSING → FAILED NO marca paidAt + emite payout.failed (rejectSeed determinista).
 *  - doble-click: el 2º disparo PENDING→PROCESSING es NO-OP (assertTransition/CAS) — no re-emite ni re-invoca.
 *  - webhook duplicado: la 2ª confirmación es idempotente (status-guard) — paidAt NO se re-marca.
 *  - reintento: FAILED → PROCESSING idempotente por la MISMA dedupKey (el riel no duplica).
 *  - MFA: total sobre el umbral sin MFA fresca → ForbiddenError (sin tocar el riel).
 *  - poll fallback: PayoutPollService consulta el sandbox y confirma los PROCESSING (cierra el ciclo async).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { ConflictError, ExternalServiceError, ForbiddenError, uuidv7 } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { PrismaClient } from '../src/generated/prisma';
import { PayoutsService } from '../src/payouts/payouts.service';
import { PayoutPollService } from '../src/payouts/payout-poll.service';
import { SandboxPayoutGateway } from '../src/ports/gateway/sandbox-payout.gateway';
import { PaymentMetrics } from '../src/metrics/payment.metrics';
import type {
  PayoutGateway,
  PayoutStatusQuery,
  DisburseRequest,
  DisburseResult,
  PayoutDisbursementQuery,
  PayoutDisbursementStatusDetail,
} from '../src/ports/gateway/payout-gateway.port';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

const PERIOD_START = new Date('2026-05-18T00:00:00.000Z');
const PERIOD_END = new Date('2026-05-25T00:00:00.000Z');
const IN_WINDOW = new Date('2026-05-20T12:00:00.000Z');

const MIN_CENTS = 5000;
const STEPUP_CENTS = 500_000;

let db: TestDatabase;
let prisma: PrismaClient;

function makeConfig(overrides: Record<string, unknown> = {}): never {
  const values: Record<string, unknown> = {
    PAYOUT_MIN_CENTS: MIN_CENTS,
    PAYOUT_STEPUP_CENTS: STEPUP_CENTS,
    PAYOUT_POLL_ENABLED: true,
    PAYOUT_POLL_INTERVAL_MS: 25_000,
    PAYOUT_POLL_MAX_AGE_MIN: 60,
    PAYOUT_POLL_BATCH: 25,
    ...overrides,
  };
  return { getOrThrow: (k: string) => values[k] } as never;
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
    smembers: async (_k: string) => [...flagged], // backstop de disbursePendingForPeriod (fix CRÍTICA retención)
    sadd: async (_k: string, m: string) => (flagged.add(m) ? 1 : 0),
    srem: async (_k: string, m: string) => (flagged.delete(m) ? 1 : 0),
  };
  return { redis, flagged };
}

/** Service con un sandbox de payout configurable (rejectSeed/confirmSync). rejectSeed 0 ⇒ nunca rechaza. */
function makeService(
  redis: unknown,
  opts: { rejectSeed?: number; confirmSync?: boolean; metrics?: PaymentMetrics } = {},
): { svc: PayoutsService; gateway: SandboxPayoutGateway } {
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const gateway = new SandboxPayoutGateway({
    rejectSeed: opts.rejectSeed ?? 0,
    confirmSync: opts.confirmSync ?? false,
  });
  return {
    svc: new PayoutsService(prismaService, redis as never, gateway, makeConfig(), opts.metrics),
    gateway,
  };
}

/**
 * Gateway que rechaza TRANSITORIO (ExternalServiceError) el desembolso de los payouts cuyo monto está en
 * `transientFor`, y para el resto se comporta como el sandbox (SUBMITTED). El payout transitorio queda
 * PROCESSING (el claim ya se commiteó) — el operador/poll lo cierra. Implementa la consulta de estado.
 */
class PartiallyTransientGateway implements PayoutGateway, PayoutStatusQuery {
  private readonly inner = new SandboxPayoutGateway({ rejectSeed: 0 });
  constructor(private readonly transientFor: Set<number>) {}
  isAvailable(): boolean {
    return true;
  }
  async disburse(req: DisburseRequest): Promise<DisburseResult> {
    if (this.transientFor.has(req.amountCents)) {
      throw new ExternalServiceError(`sandbox: transitorio determinista para monto ${req.amountCents}`);
    }
    return this.inner.disburse(req);
  }
  getDisbursementStatus(query: PayoutDisbursementQuery): Promise<PayoutDisbursementStatusDetail> {
    return this.inner.getDisbursementStatus(query);
  }
}

/** Crea un Payout PROCESSING con dedupKey pero SIN externalRef (orfandad: crash post-claim, pre-persist-ref). */
async function seedOrphanProcessingPayout(driverId: string, amountCents: number): Promise<string> {
  const id = uuidv7();
  await prisma.payout.create({
    data: {
      id,
      driverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      grossCents: 0,
      commissionCents: 0,
      amountCents,
      status: 'PROCESSING',
      dedupKey: `payout-disburse:${id}`, // el claim marker SÍ se persistió (atómico, antes del riel)
      externalRef: null, // ...pero el persist del ref murió: huérfano
      processedAt: null,
    },
  });
  return id;
}

const operatorFreshMfa: AuthenticatedUser = {
  userId: 'op-1',
  roles: ['FINANCE'],
  mfaVerifiedAt: Math.floor(Date.now() / 1000),
} as AuthenticatedUser;

const operatorNoMfa = { userId: 'op-1', roles: ['FINANCE'] } as AuthenticatedUser;

/** Crea un Payout PENDING directo (simula lo que dejó el cron) + opcionalmente un incentivo ligado. */
async function seedPendingPayout(
  driverId: string,
  amountCents: number,
): Promise<string> {
  const id = uuidv7();
  await prisma.payout.create({
    data: {
      id,
      driverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      grossCents: 0,
      commissionCents: 0,
      amountCents,
      status: 'PENDING',
      processedAt: null,
    },
  });
  return id;
}

/** Liga un incentivo COMPLETADO no-pagado al payout (paidInPayoutId set, paidAt NULL — como deja el cron). */
async function seedLinkedIncentive(driverId: string, payoutId: string, rewardCents: number): Promise<string> {
  const incentiveId = uuidv7();
  await prisma.incentive.create({
    data: {
      id: incentiveId,
      type: 'META_VIAJES',
      title: 'Meta',
      description: 'x',
      targetTrips: 20,
      rewardCents,
      active: true,
    },
  });
  const progressId = uuidv7();
  await prisma.incentiveProgress.create({
    data: {
      id: progressId,
      incentiveId,
      driverId,
      tripsCompleted: 20,
      completedAt: IN_WINDOW,
      rewardGrantedCents: rewardCents,
      paidInPayoutId: payoutId,
      paidAt: null,
    },
  });
  return progressId;
}

async function eventTypes(payoutId: string): Promise<string[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { aggregateId: payoutId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.eventType);
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
  await prisma.incentive.deleteMany({});
});

describe('ADR-015 2b · disburse PENDING→PROCESSING', () => {
  it('emite payout.processing, persiste dedupKey + externalRef, queda PROCESSING (SUBMITTED async)', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc } = makeService(redis);

    const summary = await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);

    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(0);
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PROCESSING');
    expect(payout.dedupKey).toBe(`payout-disburse:${payoutId}`); // §7 idempotencia financiera
    expect(payout.externalRef).toBe(`sbx_payout_yape_${payoutId}`); // ref del riel persistido
    expect(payout.processedAt).toBeNull(); // aún no confirmado: la plata no salió
    expect(await eventTypes(payoutId)).toEqual(['payout.processing']);
  });

  it('doble-click: el 2º disparo es NO-OP (no re-emite payout.processing, no re-invoca el riel)', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc, gateway } = makeService(redis);
    const spy = vi.spyOn(gateway, 'disburse');

    await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    // 2º disparo: el payout ya está PROCESSING (no PENDING) → no entra al filtro PENDING.
    const second = await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);

    expect(second.dispatched).toBe(0); // nada PENDING que despachar
    expect(spy).toHaveBeenCalledTimes(1); // el riel se invocó UNA sola vez
    expect(await eventTypes(payoutId)).toEqual(['payout.processing']); // un solo evento
  });

  it('MFA: total sobre el umbral sin MFA fresca → ForbiddenError sin tocar el payout', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 600_000); // > S/5000
    const { redis } = makeRedis();
    const { svc, gateway } = makeService(redis);
    const spy = vi.spyOn(gateway, 'disburse');

    await expect(
      svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorNoMfa),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PENDING'); // no se movió
    expect(spy).not.toHaveBeenCalled();
    expect(await eventTypes(payoutId)).toEqual([]);
  });
});

describe('ADR-015 2b · confirmación PROCESSING→PROCESSED|FAILED (espejo applyWebhookResult)', () => {
  it('CONFIRMED: marca paidAt del incentivo + emite payout.processed (en una tx atómica)', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const progressId = await seedLinkedIncentive(driverId, payoutId, 6000);
    const { redis } = makeRedis();
    const { svc } = makeService(redis);

    await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    const res = await svc.applyPayoutDisbursementResult({ payoutId, resolution: 'CONFIRMED' });

    expect(res).toEqual({ applied: true, status: 'PROCESSED' });
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PROCESSED');
    expect(payout.processedAt).toBeInstanceOf(Date);
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).not.toBeNull(); // el bono se marca RECIÉN al confirmar (§3/§D5)
    expect(await eventTypes(payoutId)).toEqual(['payout.processing', 'payout.processed']);
  });

  it('webhook duplicado: la 2ª confirmación es NO-OP idempotente (paidAt NO se re-marca)', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const progressId = await seedLinkedIncentive(driverId, payoutId, 6000);
    const { redis } = makeRedis();
    const { svc } = makeService(redis);

    await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    await svc.applyPayoutDisbursementResult({ payoutId, resolution: 'CONFIRMED' });
    const firstPaidAt = (
      await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } })
    ).paidAt;

    const dup = await svc.applyPayoutDisbursementResult({ payoutId, resolution: 'CONFIRMED' });

    expect(dup).toEqual({ applied: false, status: 'PROCESSED' }); // §8: redelivery no-op
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).toEqual(firstPaidAt); // mismo timestamp: no re-marcado
    expect(await eventTypes(payoutId)).toEqual(['payout.processing', 'payout.processed']); // un solo processed
  });

  it('REJECTED en línea (rejectSeed): PROCESSING→FAILED, NO marca paidAt, emite payout.failed', async () => {
    const driverId = uuidv7();
    // amount 6500 múltiplo de 13 → el sandbox lo rechaza PERMANENTE en el disburse (PROCESSING→FAILED).
    const payoutId = await seedPendingPayout(driverId, 6500);
    const progressId = await seedLinkedIncentive(driverId, payoutId, 6500);
    const { redis } = makeRedis();
    const { svc } = makeService(redis, { rejectSeed: 13 });

    const summary = await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);

    expect(summary.failed).toBe(1);
    expect(summary.dispatched).toBe(0);
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('FAILED');
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).toBeNull(); // la plata no salió → el bono NO se marca pagado
    expect(await eventTypes(payoutId)).toEqual(['payout.processing', 'payout.failed']);
  });
});

describe('ADR-015 2b · reintento FAILED→PROCESSING (idempotente por dedupKey · §7/§8)', () => {
  it('reintenta un payout FALLIDO por la MISMA dedupKey y vuelve a PROCESSING', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6500);
    const { redis } = makeRedis();
    // 1) Primer disparo con rejectSeed → FAILED.
    const failing = makeService(redis, { rejectSeed: 13 });
    await failing.svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    const failed = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(failed.status).toBe('FAILED');
    const dedupAfterFail = failed.dedupKey;

    // 2) Reintento con un riel que ya NO rechaza (rejectSeed 0) → PROCESSING, misma dedupKey.
    const retrying = makeService(redis, { rejectSeed: 0 });
    const summary = await retrying.svc.retryPayout(payoutId, operatorFreshMfa);

    expect(summary.dispatched).toBe(1);
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PROCESSING');
    expect(payout.dedupKey).toBe(dedupAfterFail); // MISMA key: el riel no duplica (§7)
    expect(payout.dedupKey).toBe(`payout-disburse:${payoutId}`);
    // El reintento confirma → PROCESSED.
    await retrying.svc.applyPayoutDisbursementResult({ payoutId, resolution: 'CONFIRMED' });
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).status).toBe(
      'PROCESSED',
    );
  });
});

describe('ADR-015 2b · poll fallback cierra el ciclo async (espejo PaymentPollService)', () => {
  it('PayoutPollService consulta el sandbox y confirma los PROCESSING → PROCESSED', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const progressId = await seedLinkedIncentive(driverId, payoutId, 6000);
    const { redis } = makeRedis();
    const { svc, gateway } = makeService(redis);

    // Disparo → PROCESSING (SUBMITTED). El sandbox anotó el ref en su libro de SUBMITTED.
    await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).status).toBe(
      'PROCESSING',
    );

    // El poll consulta el sandbox (CONFIRMED) y aplica por el camino idempotente.
    const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
    const scheduler = { addInterval: () => {}, deleteInterval: () => {}, doesExist: () => false } as never;
    const poll = new PayoutPollService(
      prismaService,
      redis as never,
      gateway,
      svc,
      scheduler,
      makeConfig(),
    );
    // running debe estar activo para que pollOnce barra (lo activa tick(); acá lo seteamos directo).
    (poll as unknown as { running: boolean }).running = true;
    const out = await poll.pollOnce();

    expect(out.applied).toBe(1);
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PROCESSED');
    const progress = await prisma.incentiveProgress.findUniqueOrThrow({ where: { id: progressId } });
    expect(progress.paidAt).not.toBeNull(); // el poll cerró el ciclo: el bono se marcó al confirmar
  });
});

/* ───────────── Bugs de plata del gate adversarial (causa raíz, un test por modo de falla) ───────────── */

describe('FIX 1 · retryPayout SOLO desde FAILED (cierra la doble-transferencia)', () => {
  // Causa raíz: retryPayout no validaba su invariante; canTransitionPayout cortocircuita from===to, así un
  // PROCESSING pasaba assertTransition(PROCESSING,PROCESSING) + el CAS matcheaba → re-invocaba el riel.
  it.each(['PROCESSING', 'PENDING', 'HELD', 'PROCESSED'] as const)(
    'rechaza el reintento de un payout %s (ConflictError) y NO toca el riel',
    async (status) => {
      const driverId = uuidv7();
      const payoutId = await seedPendingPayout(driverId, 6000);
      // Llevamos el payout al estado bajo prueba (directo en DB: simula el estado real previo al reintento).
      await prisma.payout.update({
        where: { id: payoutId },
        data: { status, dedupKey: `payout-disburse:${payoutId}`, externalRef: 'x' },
      });
      const { redis } = makeRedis();
      const { svc, gateway } = makeService(redis);
      const spy = vi.spyOn(gateway, 'disburse');

      await expect(svc.retryPayout(payoutId, operatorFreshMfa)).rejects.toBeInstanceOf(ConflictError);
      expect(spy).not.toHaveBeenCalled(); // el riel NO se invocó: no hay segunda transferencia
      // El estado no cambió por el reintento rechazado.
      expect((await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).status).toBe(status);
    },
  );
});

describe('FIX 2 · el poll reconcilia un PROCESSING HUÉRFANO (dedupKey sin externalRef)', () => {
  // Causa raíz: el poll filtraba externalRef NOT null y un PROCESSING que perdió su externalRef (crash
  // post-claim) quedaba huérfano. Ahora el ancla es el dedupKey (claim marker, siempre presente).
  it('reconcilia por dedupKey un PROCESSING sin externalRef → PROCESSED (no queda huérfano)', async () => {
    const driverId = uuidv7();
    const orphanId = await seedOrphanProcessingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc, gateway } = makeService(redis);

    // Primero el riel debe CONOCER el desembolso (anotar el ref en su libro): disparamos el MISMO payout por
    // su dedupKey determinista. En la realidad el disburse-OK ocurrió antes del crash; acá lo re-anotamos.
    await gateway.disburse({
      payoutId: orphanId,
      driverId,
      amountCents: 6000,
      method: 'YAPE',
      currency: 'PEN',
    });

    const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
    const scheduler = { addInterval: () => {}, deleteInterval: () => {}, doesExist: () => false } as never;
    const poll = new PayoutPollService(prismaService, redis as never, gateway, svc, scheduler, makeConfig());
    (poll as unknown as { running: boolean }).running = true;
    const out = await poll.pollOnce();

    expect(out.scanned).toBe(1); // el huérfano (sin externalRef) SÍ entra al barrido (filtro por dedupKey)
    expect(out.applied).toBe(1); // ...y se reconcilia por la dedupKey
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: orphanId } });
    expect(payout.status).toBe('PROCESSED'); // cerrado: ya no es un huérfano colgado para siempre
  });
});

describe('FIX 3 · disburseEach resiliente por item (un transitorio NO aborta el lote)', () => {
  // Causa raíz: disburseEach hacía throw ante un ExternalServiceError de un item → abortaba el lote entero.
  it('lote de 3, el del medio lanza transitorio → los otros 2 se despachan, 1 failed, no aborta', async () => {
    const driverId = uuidv7();
    const a = await seedPendingPayout(driverId, 6000);
    const mid = await seedPendingPayout(uuidv7(), 6001); // monto transitorio
    const c = await seedPendingPayout(uuidv7(), 6002);
    const { redis } = makeRedis();
    const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
    const gateway = new PartiallyTransientGateway(new Set([6001]));
    const svc = new PayoutsService(prismaService, redis as never, gateway, makeConfig());

    const summary = await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);

    expect(summary.dispatched).toBe(2); // a y c salieron en línea
    expect(summary.failed).toBe(1); // el del medio (transitorio) no salió en línea
    // El lote NO abortó: a y c quedaron PROCESSING (despachados).
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: a } })).status).toBe('PROCESSING');
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: c } })).status).toBe('PROCESSING');
    // El transitorio quedó PROCESSING con su dedupKey (el claim se commiteó antes del riel) → poll/retry lo cierra.
    const midPayout = await prisma.payout.findUniqueOrThrow({ where: { id: mid } });
    expect(midPayout.status).toBe('PROCESSING');
    expect(midPayout.dedupKey).toBe(`payout-disburse:${mid}`);
  });
});

describe('FIX 4 · releaseHeldPayouts no deja al conductor flaggeado-para-siempre', () => {
  // Causa raíz: el srem corría DESPUÉS de un disburseEach que podía lanzar; un transitorio del riel saltaba el
  // srem y dejaba al conductor retenido para siempre (su payout ya PROCESSING, pero el flag intacto).
  it('release con un disburse transitorio → conductor DES-flaggeado + HELD movidos a PROCESSING', async () => {
    const driverId = uuidv7();
    // Dos HELD del MISMO conductor en PERÍODOS distintos (el unique es driver+período); uno rebota transitorio.
    const h1 = uuidv7();
    const h2 = uuidv7();
    const PERIOD_START_2 = new Date('2026-05-11T00:00:00.000Z');
    const PERIOD_END_2 = new Date('2026-05-18T00:00:00.000Z');
    for (const [id, amount, pStart, pEnd] of [
      [h1, 6000, PERIOD_START, PERIOD_END],
      [h2, 6001, PERIOD_START_2, PERIOD_END_2], // transitorio
    ] as const) {
      await prisma.payout.create({
        data: {
          id,
          driverId,
          periodStart: pStart,
          periodEnd: pEnd,
          grossCents: 0,
          commissionCents: 0,
          amountCents: amount,
          status: 'HELD',
          heldReason: 'driver_in_review',
          processedAt: null,
        },
      });
    }
    const { redis, flagged } = makeRedis();
    flagged.add(driverId); // el conductor está flaggeado (review en curso)
    const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
    const gateway = new PartiallyTransientGateway(new Set([6001]));
    const svc = new PayoutsService(prismaService, redis as never, gateway, makeConfig());

    const res = await svc.releaseHeldPayouts(driverId, operatorFreshMfa);

    // released = los movidos de HELD a PROCESSING (salgan o no en línea): ambos.
    expect(res.released).toBe(2);
    // CRÍTICO: el conductor quedó DES-flaggeado pese al transitorio (antes quedaba flaggeado para siempre).
    expect(flagged.has(driverId)).toBe(false);
    // Ambos HELD se movieron a PROCESSING (el transitorio incluido: su plata ya está en el riel/poll).
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: h1 } })).status).toBe('PROCESSING');
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: h2 } })).status).toBe('PROCESSING');
  });
});

describe('FIX 5 · métricas del carril money-OUT (CLAUDE §6)', () => {
  it('emite dispatched al despachar, retried al reintentar, processed al confirmar, failed al rechazar', async () => {
    const metrics = new PaymentMetrics();
    const spy = vi.spyOn(metrics, 'incPayoutDisbursement');

    // dispatched (SUBMITTED) + processed (confirmación).
    const driverId = uuidv7();
    const okId = await seedPendingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc } = makeService(redis, { metrics });
    await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    expect(spy).toHaveBeenCalledWith('dispatched');
    await svc.applyPayoutDisbursementResult({ payoutId: okId, resolution: 'CONFIRMED' });
    expect(spy).toHaveBeenCalledWith('processed');

    // failed (rechazo permanente en línea, vía applyPayoutDisbursementResult).
    const failId = await seedPendingPayout(uuidv7(), 6500);
    const failing = makeService(redis, { rejectSeed: 13, metrics });
    await failing.svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);
    expect(spy).toHaveBeenCalledWith('failed');

    // retried (reintento de un FAILED).
    const retrying = makeService(redis, { rejectSeed: 0, metrics });
    await retrying.svc.retryPayout(failId, operatorFreshMfa);
    expect(spy).toHaveBeenCalledWith('retried');
  });
});

/**
 * Adapter que ESPEJA el `YapePlinPayoutGateway` live diferido (convenio PSP pendiente): NO disponible
 * (`isAvailable()=false`) y `disburse` lanza. El gate pre-claim del dominio debe rechazar el disparo
 * ANTES de tocar el estado del payout → `disburse` NUNCA se llega a invocar. Si se invocara, el spy lo caza.
 */
class LiveUnavailableGateway implements PayoutGateway {
  disburse = vi.fn(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (_req: DisburseRequest): Promise<DisburseResult> => {
      throw new ExternalServiceError('payout live no disponible: convenio PSP pendiente');
    },
  );
  isAvailable(): boolean {
    return false;
  }
}

describe('ALTA · gate pre-claim: riel money-OUT no disponible (ADR-015 §8 · causa raíz)', () => {
  // Causa raíz cerrada: el disparo (run/release/retry) reclamaba el payout PENDING/HELD/FAILED → PROCESSING
  // (commit) y SOLO DESPUÉS invocaba disburse(); con el live stub que lanza, el payout quedaba PROCESSING
  // COLGADO (el poll no lo cierra: el stub no tiene status real). Ahora el dominio consulta isAvailable()
  // ANTES del claim: si el riel no puede desembolsar, falla-rápido (ExternalServiceError 502) SIN mover un
  // solo payout. Ningún payout queda atascado; el operador ve el error. disburse() jamás se invoca.

  function makeUnavailableService(redis: unknown): {
    svc: PayoutsService;
    gateway: LiveUnavailableGateway;
  } {
    const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
    const gateway = new LiveUnavailableGateway();
    return {
      svc: new PayoutsService(prismaService, redis as never, gateway, makeConfig()),
      gateway,
    };
  }

  it('run (disbursePendingForPeriod): lanza ExternalServiceError, el PENDING NO cambia, disburse NO se invoca', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc, gateway } = makeUnavailableService(redis);

    await expect(
      svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa),
    ).rejects.toBeInstanceOf(ExternalServiceError);

    expect(gateway.disburse).not.toHaveBeenCalled(); // ASSERT CLAVE: ni se tocó el riel
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(payout.status).toBe('PENDING'); // ASSERT CLAVE: NINGÚN payout quedó PROCESSING colgado
    expect(payout.dedupKey).toBeNull(); // no hubo claim: el dedupKey no se persistió
    expect(await eventTypes(payoutId)).toEqual([]); // no se emitió payout.processing
  });

  it('release (releaseHeldPayouts): lanza, el HELD NO cambia, NO des-flaguea, disburse NO se invoca', async () => {
    const driverId = uuidv7();
    const heldId = uuidv7();
    await prisma.payout.create({
      data: {
        id: heldId,
        driverId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        grossCents: 0,
        commissionCents: 0,
        amountCents: 6000,
        status: 'HELD',
        heldReason: 'driver_in_review',
        processedAt: null,
      },
    });
    const { redis, flagged } = makeRedis();
    flagged.add(driverId);
    const { svc, gateway } = makeUnavailableService(redis);

    await expect(svc.releaseHeldPayouts(driverId, operatorFreshMfa)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );

    expect(gateway.disburse).not.toHaveBeenCalled();
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: heldId } })).status).toBe('HELD');
    // El flag NO se quita: la liberación falló-rápido ANTES de mover nada (no hay release a medias).
    expect(flagged.has(driverId)).toBe(true);
    expect(await eventTypes(heldId)).toEqual([]);
  });

  it('retry (retryPayout): lanza, el FAILED NO cambia, disburse NO se invoca', async () => {
    const driverId = uuidv7();
    const failedId = await seedPendingPayout(driverId, 6000);
    await prisma.payout.update({
      where: { id: failedId },
      data: { status: 'FAILED', dedupKey: `payout-disburse:${failedId}`, externalRef: 'x' },
    });
    const { redis } = makeRedis();
    const { svc, gateway } = makeUnavailableService(redis);

    await expect(svc.retryPayout(failedId, operatorFreshMfa)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );

    expect(gateway.disburse).not.toHaveBeenCalled();
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: failedId } })).status).toBe('FAILED');
  });

  it('sandbox (isAvailable=true): el flujo corre IGUAL — regresión, el gate no afecta dev/test', async () => {
    const driverId = uuidv7();
    const payoutId = await seedPendingPayout(driverId, 6000);
    const { redis } = makeRedis();
    const { svc } = makeService(redis); // sandbox real: isAvailable()=true

    const summary = await svc.disbursePendingForPeriod(PERIOD_START, PERIOD_END, operatorFreshMfa);

    expect(summary.dispatched).toBe(1); // despachó normal: el gate dejó pasar
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).status).toBe(
      'PROCESSING',
    );
  });
});
