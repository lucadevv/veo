/**
 * Tests del camino de VUELTA de driver.flagged (S4): releaseHeldPayouts (ADR-015 §3/§D5 · sub-lote 2b).
 *  - Libera HELD→PROCESSING (entra al carril de desembolso, NO salta a PROCESSED), emite payout.processing
 *    por outbox (misma tx) e invoca el riel; des-flaguea (srem).
 *  - Idempotente: una segunda liberación libera 0 y NO re-emite.
 *  - Plata grande sin MFA fresca → ForbiddenError SIN tocar payouts ni redis (espejo de runPayouts).
 *
 * Estilo del repo: dobles construidos a mano, sin Nest DI (como consumers.poison.spec).
 */
import { describe, it, expect, vi } from 'vitest';
import { ExternalServiceError, ForbiddenError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { PayoutsService } from './payouts.service';
import type { PrismaService } from '../infra/prisma.service';
import type {
  PayoutGateway,
  DisburseRequest,
  DisburseResult,
} from '../ports/gateway/payout-gateway.port';

/**
 * Gateway fake: el desembolso queda SUBMITTED (async) — el payout queda PROCESSING esperando confirmación.
 * `available` (default true) controla el gate pre-claim de disponibilidad del riel (ADR-015 §8): con
 * false simulamos el adapter live diferido (convenio PSP pendiente) → el disparo debe fallar-rápido.
 */
function makeGateway(available = true): PayoutGateway & { calls: DisburseRequest[] } {
  const calls: DisburseRequest[] = [];
  return {
    calls,
    isAvailable: vi.fn(() => available),
    disburse: vi.fn(async (req: DisburseRequest): Promise<DisburseResult> => {
      calls.push(req);
      return { externalRef: `ref_${req.payoutId}`, status: 'SUBMITTED' };
    }),
  };
}

interface FakePayout {
  id: string;
  driverId: string;
  periodStart: Date;
  periodEnd: Date;
  grossCents: number;
  commissionCents: number;
  amountCents: number;
  status: string;
  processedAt: Date | null;
  heldReason: string | null;
  dedupKey: string | null;
  externalRef: string | null;
}

const config = {
  getOrThrow: (k: string): number => (k === 'PAYOUT_MIN_CENTS' ? 5000 : 500_000),
} as never;

function heldPayout(id: string, driverId: string, amountCents: number): FakePayout {
  return {
    id,
    driverId,
    periodStart: new Date('2026-05-18T00:00:00Z'),
    periodEnd: new Date('2026-05-25T00:00:00Z'),
    grossCents: amountCents,
    commissionCents: 0,
    amountCents,
    status: 'HELD',
    processedAt: null,
    heldReason: 'driver_in_review',
    dedupKey: null,
    externalRef: null,
  };
}

/** Payout PENDING (nacido del cron, a la espera del disparo del operador) — el estado que el fix debe retener. */
function pendingPayout(id: string, driverId: string, amountCents: number): FakePayout {
  return { ...heldPayout(id, driverId, amountCents), status: 'PENDING', heldReason: null };
}

function makePrisma(rows: FakePayout[]) {
  const payouts = new Map(rows.map((p) => [p.id, p]));
  const outbox: { aggregateId: string; eventType: string; envelope: unknown }[] = [];
  const tx = {
    payout: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: Partial<FakePayout>;
        }) => {
          const p = payouts.get(where.id);
          if (p?.status !== where.status) return { count: 0 };
          Object.assign(p, data);
          return { count: 1 };
        },
      ),
    },
    outboxEvent: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: { aggregateId: string; eventType: string; envelope: unknown };
        }) => {
          outbox.push(data);
          return data;
        },
      ),
    },
  };
  // Filtro genérico: soporta la query por-driverId (release) Y la query por-período (disbursePendingForPeriod).
  const matches = (
    p: FakePayout,
    where: { driverId?: string; status?: string; periodStart?: Date; periodEnd?: Date },
  ): boolean =>
    (where.driverId === undefined || p.driverId === where.driverId) &&
    (where.status === undefined || p.status === where.status) &&
    (where.periodStart === undefined || +p.periodStart === +where.periodStart) &&
    (where.periodEnd === undefined || +p.periodEnd === +where.periodEnd);
  const prisma = {
    read: {
      payout: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          [...payouts.values()].filter((p) => matches(p, where)),
        ),
      },
    },
    write: {
      $transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      // disburseOne persiste el externalRef FUERA de la tx (I/O externo): el doble lo aplica al row.
      payout: {
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<FakePayout> }) => {
            const p = payouts.get(where.id);
            if (p) Object.assign(p, data);
            return p;
          },
        ),
        // holdDriver (retro-hold por driverId) + disbursePendingForPeriod (backstop por id:{in}). CAS por status.
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { driverId?: string; id?: { in: string[] }; status?: string };
            data: Partial<FakePayout>;
          }) => {
            let count = 0;
            for (const p of payouts.values()) {
              const idOk = where.id === undefined || where.id.in.includes(p.id);
              const drvOk = where.driverId === undefined || p.driverId === where.driverId;
              const stOk = where.status === undefined || p.status === where.status;
              if (idOk && drvOk && stOk) {
                Object.assign(p, data);
                count++;
              }
            }
            return { count };
          },
        ),
      },
    },
  } as unknown as PrismaService;
  return { prisma, payouts, outbox };
}

function makeRedis() {
  const flagged = new Set<string>(['drv-1']);
  return {
    flagged,
    redis: {
      sadd: vi.fn(async (_k: string, m: string) => flagged.add(m) && 1),
      srem: vi.fn(async (_k: string, m: string) => (flagged.delete(m) ? 1 : 0)),
      sismember: vi.fn(async (_k: string, m: string) => (flagged.has(m) ? 1 : 0)),
      smembers: vi.fn(async () => [...flagged]),
    },
  };
}

const operatorWithFreshMfa: AuthenticatedUser = {
  userId: 'op-1',
  roles: ['FINANCE'],
  mfaVerifiedAt: Math.floor(Date.now() / 1000),
} as AuthenticatedUser;

describe('PayoutsService.releaseHeldPayouts (S4 · camino de vuelta de driver.flagged)', () => {
  it('libera HELD→PROCESSING, emite payout.processing por outbox, invoca el riel y des-flaguea (srem)', async () => {
    const { prisma, payouts, outbox } = makePrisma([
      heldPayout('po-1', 'drv-1', 4000),
      heldPayout('po-2', 'drv-1', 6000),
    ]);
    const { redis, flagged } = makeRedis();
    const gateway = makeGateway();
    const svc = new PayoutsService(prisma, redis as never, gateway, config);

    const res = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    // ADR-015 §3/§D5: liberar = entrar al desembolso, NO saltar a PROCESSED. La plata sale por el riel.
    expect(res).toEqual({ driverId: 'drv-1', released: 2, totalAmountCents: 10000 });
    expect(payouts.get('po-1')!.status).toBe('PROCESSING');
    expect(payouts.get('po-2')!.status).toBe('PROCESSING');
    expect(payouts.get('po-1')!.dedupKey).toBe('payout-disburse:po-1'); // idempotencia financiera (§7)
    expect(payouts.get('po-1')!.externalRef).toBe('ref_po-1'); // ref del riel persistido
    // Dominó: un payout.processing por payout, en la MISMA tx (outbox). El riel se invocó por cada uno.
    expect(outbox.map((o) => o.eventType)).toEqual(['payout.processing', 'payout.processing']);
    expect(gateway.calls).toHaveLength(2);
    // Des-flag: las próximas liquidaciones del conductor ya no nacen HELD.
    expect(flagged.has('drv-1')).toBe(false);
  });

  it('es idempotente: una segunda liberación libera 0 y NO re-emite eventos', async () => {
    const { prisma, outbox } = makePrisma([heldPayout('po-1', 'drv-1', 4000)]);
    const { redis } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, makeGateway(), config);

    await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);
    const second = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    expect(second).toEqual({ driverId: 'drv-1', released: 0, totalAmountCents: 0 });
    expect(outbox).toHaveLength(1); // solo el payout.processing de la primera liberación
  });

  it('plata grande SIN MFA fresca → ForbiddenError, sin liberar ni des-flaguear (BR-S07)', async () => {
    const { prisma, payouts, outbox } = makePrisma([heldPayout('po-1', 'drv-1', 600_000)]);
    const { redis, flagged } = makeRedis();
    const gateway = makeGateway();
    const svc = new PayoutsService(prisma, redis as never, gateway, config);
    const staleOperator = { userId: 'op-1', roles: ['FINANCE'] } as AuthenticatedUser;

    await expect(svc.releaseHeldPayouts('drv-1', staleOperator)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(payouts.get('po-1')!.status).toBe('HELD');
    expect(outbox).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0); // el riel NO se tocó (gate antes de mover plata)
    expect(flagged.has('drv-1')).toBe(true); // la retención sigue en pie
  });

  it('riel money-OUT NO disponible (live diferido): falla-rápido SIN mover el HELD ni des-flaguear (ADR-015 §8)', async () => {
    const { prisma, payouts, outbox } = makePrisma([heldPayout('po-1', 'drv-1', 4000)]);
    const { redis, flagged } = makeRedis();
    const gateway = makeGateway(false); // isAvailable()=false: espeja el YapePlinPayoutGateway diferido
    const svc = new PayoutsService(prisma, redis as never, gateway, config);

    // Gate pre-claim: rechaza el disparo ANTES de tocar el estado → ningún payout queda PROCESSING colgado.
    await expect(svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(gateway.calls).toHaveLength(0); // ASSERT CLAVE: el riel NUNCA se invocó
    expect(payouts.get('po-1')!.status).toBe('HELD'); // ASSERT CLAVE: el HELD no cambió de estado
    expect(payouts.get('po-1')!.dedupKey).toBeNull(); // no hubo claim
    expect(outbox).toHaveLength(0); // no se emitió payout.processing
    expect(flagged.has('drv-1')).toBe(true); // NO se des-flagueó (no hay release a medias)
  });

  it('conductor sin payouts HELD: no-op honesto (released=0) pero igual des-flaguea', async () => {
    const { prisma, outbox } = makePrisma([]);
    const { redis, flagged } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, makeGateway(), config);

    const res = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    expect(res).toEqual({ driverId: 'drv-1', released: 0, totalAmountCents: 0 });
    expect(outbox).toHaveLength(0);
    expect(flagged.has('drv-1')).toBe(false);
  });
});

describe('PayoutsService · gate de review en el DESEMBOLSO (fix crítico · driver.flagged post-cron)', () => {
  it('holdDriver retro-flippea a HELD los Payout PENDING existentes del conductor (+ sadd)', async () => {
    // drv-2 tiene un PENDING (nacido del cron) y NO estaba flaggeado; llega driver.flagged.
    const { prisma, payouts } = makePrisma([pendingPayout('po-1', 'drv-2', 4000)]);
    const { redis, flagged } = makeRedis(); // flagged = {drv-1}
    const svc = new PayoutsService(prisma, redis as never, makeGateway(), config);

    await svc.holdDriver('drv-2');

    expect(flagged.has('drv-2')).toBe(true); // sadd: los futuros nacen HELD
    expect(payouts.get('po-1')!.status).toBe('HELD'); // retro-hold: el PENDING vigente NO se desembolsa
    expect(payouts.get('po-1')!.heldReason).toBe('driver_in_review');
  });

  it('disbursePendingForPeriod RETIENE (→HELD) el PENDING de un driver flaggeado y desembolsa SOLO los limpios', async () => {
    const start = new Date('2026-05-18T00:00:00Z');
    const end = new Date('2026-05-25T00:00:00Z');
    // po-flagged: driver EN REVIEW (drv-1 ∈ flagged). po-clean: driver limpio (drv-2). Simula el flag llegado
    // DESPUÉS de la agregación (ambos ya PENDING) y ANTES del disparo del operador.
    const { prisma, payouts } = makePrisma([
      pendingPayout('po-flagged', 'drv-1', 4000),
      pendingPayout('po-clean', 'drv-2', 6000),
    ]);
    const { redis } = makeRedis(); // flagged = {drv-1}
    const gateway = makeGateway();
    const svc = new PayoutsService(prisma, redis as never, gateway, config);

    await svc.disbursePendingForPeriod(start, end);

    // El conductor EN REVIEW NO cobra: su payout queda HELD (se liberará al resolver el review).
    expect(payouts.get('po-flagged')!.status).toBe('HELD');
    expect(payouts.get('po-flagged')!.heldReason).toBe('driver_in_review');
    // El limpio SÍ va al riel money-OUT (PROCESSING).
    expect(payouts.get('po-clean')!.status).toBe('PROCESSING');
    // ASSERT CLAVE: el riel se invocó SOLO para el limpio, NUNCA para el conductor en review.
    expect(gateway.calls.map((c) => c.payoutId)).toEqual(['po-clean']);
  });
});
