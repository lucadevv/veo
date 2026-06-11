/**
 * Tests del camino de VUELTA de driver.flagged (S4): releaseHeldPayouts.
 *  - Libera HELD→PROCESSED, emite payout.processed por outbox (misma tx) y des-flaguea (srem).
 *  - Idempotente: una segunda liberación libera 0 y NO re-emite.
 *  - Plata grande sin MFA fresca → ForbiddenError SIN tocar payouts ni redis (espejo de runPayouts).
 *
 * Estilo del repo: dobles construidos a mano, sin Nest DI (como consumers.poison.spec).
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { PayoutsService } from './payouts.service';
import type { PrismaService } from '../infra/prisma.service';

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
  };
}

function makePrisma(rows: FakePayout[]) {
  const payouts = new Map(rows.map((p) => [p.id, p]));
  const outbox: { aggregateId: string; eventType: string; envelope: unknown }[] = [];
  const tx = {
    payout: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Partial<FakePayout> }) => {
        const p = payouts.get(where.id);
        if (!p || p.status !== where.status) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: { aggregateId: string; eventType: string; envelope: unknown } }) => {
        outbox.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    read: {
      payout: {
        findMany: vi.fn(async ({ where }: { where: { driverId: string; status: string } }) =>
          [...payouts.values()].filter((p) => p.driverId === where.driverId && p.status === where.status),
        ),
      },
    },
    write: { $transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) },
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
    },
  };
}

const operatorWithFreshMfa: AuthenticatedUser = {
  userId: 'op-1',
  roles: ['FINANCE'],
  mfaVerifiedAt: Math.floor(Date.now() / 1000),
} as AuthenticatedUser;

describe('PayoutsService.releaseHeldPayouts (S4 · camino de vuelta de driver.flagged)', () => {
  it('libera HELD→PROCESSED, emite payout.processed por outbox y des-flaguea (srem)', async () => {
    const { prisma, payouts, outbox } = makePrisma([
      heldPayout('po-1', 'drv-1', 4000),
      heldPayout('po-2', 'drv-1', 6000),
    ]);
    const { redis, flagged } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, config);

    const res = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    expect(res).toEqual({ driverId: 'drv-1', released: 2, totalAmountCents: 10000 });
    expect(payouts.get('po-1')!.status).toBe('PROCESSED');
    expect(payouts.get('po-2')!.status).toBe('PROCESSED');
    expect(payouts.get('po-1')!.processedAt).toBeInstanceOf(Date);
    // Dominó completo: un payout.processed por payout liberado, en la MISMA tx (outbox).
    expect(outbox).toHaveLength(2);
    expect(outbox.map((o) => o.eventType)).toEqual(['payout.processed', 'payout.processed']);
    // Des-flag: las próximas liquidaciones del conductor ya no nacen HELD.
    expect(flagged.has('drv-1')).toBe(false);
  });

  it('es idempotente: una segunda liberación libera 0 y NO re-emite eventos', async () => {
    const { prisma, outbox } = makePrisma([heldPayout('po-1', 'drv-1', 4000)]);
    const { redis } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, config);

    await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);
    const second = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    expect(second).toEqual({ driverId: 'drv-1', released: 0, totalAmountCents: 0 });
    expect(outbox).toHaveLength(1); // solo el de la primera liberación
  });

  it('plata grande SIN MFA fresca → ForbiddenError, sin liberar ni des-flaguear (BR-S07)', async () => {
    const { prisma, payouts, outbox } = makePrisma([heldPayout('po-1', 'drv-1', 600_000)]);
    const { redis, flagged } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, config);
    const staleOperator = { userId: 'op-1', roles: ['FINANCE'] } as AuthenticatedUser;

    await expect(svc.releaseHeldPayouts('drv-1', staleOperator)).rejects.toBeInstanceOf(ForbiddenError);
    expect(payouts.get('po-1')!.status).toBe('HELD');
    expect(outbox).toHaveLength(0);
    expect(flagged.has('drv-1')).toBe(true); // la retención sigue en pie
  });

  it('conductor sin payouts HELD: no-op honesto (released=0) pero igual des-flaguea', async () => {
    const { prisma, outbox } = makePrisma([]);
    const { redis, flagged } = makeRedis();
    const svc = new PayoutsService(prisma, redis as never, config);

    const res = await svc.releaseHeldPayouts('drv-1', operatorWithFreshMfa);

    expect(res).toEqual({ driverId: 'drv-1', released: 0, totalAmountCents: 0 });
    expect(outbox).toHaveLength(0);
    expect(flagged.has('drv-1')).toBe(false);
  });
});
