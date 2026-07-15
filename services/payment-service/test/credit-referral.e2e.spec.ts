/**
 * E2E con Postgres REAL (testcontainers) — la acreditación de crédito de referido es un invariante de
 * DINERO: un `referral.rewarded` re-entregado NO debe acreditar dos veces (idempotencia financiera §3).
 * Sin mock de DB (CLAUDE: pagos NO se mockean). Verifica el guard atómico `UserCreditEntry.sourceRef`
 * UNIQUE: el INSERT del movimiento va ANTES del increment, así un eventId repetido aborta la tx entera
 * y el saldo no se mueve.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { CreditService } from '../src/credit/credit.service';
import { CreditRepository } from '../src/credit/credit.repository';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let credit: CreditService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  credit = new CreditService(new CreditRepository(prismaService));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

async function balance(userId: string): Promise<number> {
  const row = await prisma.userCredit.findUnique({ where: { userId } });
  return row?.balanceCents ?? 0;
}
async function entryCount(userId: string): Promise<number> {
  return prisma.userCreditEntry.count({ where: { userId } });
}

describe('CreditService · acreditación de referido (idempotencia financiera)', () => {
  it('acredita rewardCents al saldo gastable + 1 entrada de ledger', async () => {
    const userId = '0192f8a0-0000-7000-8000-0000000000c1';
    const applied = await credit.creditFromReferral({
      userId,
      rewardCents: 1500,
      eventId: uuidv7(),
    });
    expect(applied).toBe(true);
    expect(await balance(userId)).toBe(1500);
    expect(await entryCount(userId)).toBe(1);
  });

  it('el MISMO eventId re-entregado NO re-acredita (sourceRef UNIQUE aborta la tx)', async () => {
    const userId = '0192f8a0-0000-7000-8000-0000000000c2';
    const eventId = uuidv7();
    const first = await credit.creditFromReferral({ userId, rewardCents: 2000, eventId });
    const second = await credit.creditFromReferral({ userId, rewardCents: 2000, eventId }); // re-entrega
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await balance(userId)).toBe(2000); // sin doble-acreditación
    expect(await entryCount(userId)).toBe(1);
  });

  it('eventIds DISTINTOS acumulan en el saldo', async () => {
    const userId = '0192f8a0-0000-7000-8000-0000000000c3';
    await credit.creditFromReferral({ userId, rewardCents: 1000, eventId: uuidv7() });
    await credit.creditFromReferral({ userId, rewardCents: 500, eventId: uuidv7() });
    expect(await balance(userId)).toBe(1500);
    expect(await entryCount(userId)).toBe(2);
  });

  it('rewardCents <= 0 no acredita (defensivo)', async () => {
    const userId = '0192f8a0-0000-7000-8000-0000000000c4';
    const applied = await credit.creditFromReferral({ userId, rewardCents: 0, eventId: uuidv7() });
    expect(applied).toBe(false);
    expect(await balance(userId)).toBe(0);
    expect(await entryCount(userId)).toBe(0);
  });
});
