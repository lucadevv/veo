/**
 * Canje de promociones bajo CONCURRENCIA · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en un
 * crítico de dinero (CLAUDE). Prueba el cierre de la TOCTOU del tope agregado (RC22 · ADR-022): antes,
 * `usageFor` + `evaluatePromo` corrían FUERA de la tx, así que dos canjes concurrentes de la misma promo
 * (viajes/usuarios distintos, que NO violan el UNIQUE por dedupKey ni por tripleta) leían el mismo count < cap
 * y ambos insertaban → el tope `maxTotalUses`/`maxUsesPerUser` se excedía (crédito duplicado). El fix serializa
 * los canjes de cada promo con un advisory lock transaccional y re-cuenta DENTRO de la tx.
 *
 * El caso feliz + idempotencia vive en las policies puras (promotions.policy.spec); acá se ejercita SOLO lo que
 * exige DB real: la carrera del tope, que un fake no puede reproducir.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7, ValidationError } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { PromotionsService } from '../src/promotions/promotions.service';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const USER_A = '0192f8a0-0000-7000-8000-0000000000a1';
const USER_B = '0192f8a0-0000-7000-8000-0000000000b2';

let db: TestDatabase;
let prisma: PrismaClient;
let promos: PromotionsService;

/** Siembra una promo FIXED (descuento fijo en céntimos) con los topes pedidos. Devuelve el code normalizado. */
async function seedPromo(opts: {
  code: string;
  discountCents: number;
  maxTotalUses: number;
  maxUsesPerUser: number;
}): Promise<string> {
  await prisma.promotion.create({
    data: {
      id: uuidv7(),
      code: opts.code,
      kind: 'FIXED',
      value: opts.discountCents,
      minFareCents: 0,
      maxTotalUses: opts.maxTotalUses,
      maxUsesPerUser: opts.maxUsesPerUser,
      active: true,
    },
  });
  return opts.code;
}

function redeem(code: string, userId: string, tripId: string) {
  return promos.redeemPromo({
    code,
    userId,
    tripId,
    fareCents: 3000,
    dedupKey: `redeem:${tripId}`, // dedupKey por viaje → dos viajes distintos NO colisionan por el UNIQUE
  });
}

// tripId es @db.Uuid en el schema → los ids de viaje deben ser UUIDs reales (no strings arbitrarios).
const tripId = () => uuidv7();

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  promos = new PromotionsService(prismaService);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.promoRedemption.deleteMany({});
  await prisma.promotion.deleteMany({});
});

describe('RC22 · canje de promo bajo concurrencia — el tope agregado se respeta (advisory lock + re-count in-tx)', () => {
  it('maxTotalUses=1: dos usuarios distintos canjean A LA VEZ → exactamente 1 gana, el otro EXHAUSTED_TOTAL', async () => {
    const code = await seedPromo({
      code: 'SOLO1',
      discountCents: 500,
      maxTotalUses: 1,
      maxUsesPerUser: 1,
    });
    // Dos viajes/usuarios distintos → NO chocan por el UNIQUE (dedupKey/tripleta). La ÚNICA barrera es el tope,
    // que sin el fix ambos pasarían (count 0 < 1 en los dos). Con el lock, uno cuenta 0 y gana; el otro cuenta 1.
    const [r1, r2] = await Promise.allSettled([
      redeem(code, USER_A, tripId()),
      redeem(code, USER_B, tripId()),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // EXACTAMENTE un canje, no dos
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);

    // La DB es la verdad: una sola redención registrada (el tope NO se excedió).
    expect(await prisma.promoRedemption.count()).toBe(1);
  });

  it('maxUsesPerUser=1: el MISMO usuario canjea en dos viajes A LA VEZ → 1 gana, el otro EXHAUSTED_USER', async () => {
    const code = await seedPromo({
      code: 'PERUSER1',
      discountCents: 700,
      maxTotalUses: 0, // total ilimitado; la barrera es el tope POR USUARIO
      maxUsesPerUser: 1,
    });
    // Mismo usuario, dos viajes distintos → tripleta distinta (no viola UNIQUE), pero el tope por-usuario es 1.
    const [r1, r2] = await Promise.allSettled([
      redeem(code, USER_A, tripId()),
      redeem(code, USER_A, tripId()),
    ]);

    expect([r1, r2].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.promoRedemption.count({ where: { userId: USER_A } })).toBe(1);
  });

  it('idempotencia bajo carrera: mismo (usuario, viaje) doble-submit concurrente → un solo canje, mismo id', async () => {
    const code = await seedPromo({
      code: 'IDEMP',
      discountCents: 400,
      maxTotalUses: 0,
      maxUsesPerUser: 5,
    });
    // MISMO viaje → misma dedupKey y misma tripleta → el UNIQUE + el catch de isUniqueViolation garantizan un
    // único canje; ambos requests deben resolver al MISMO registro (no lanza, no duplica).
    const dupTrip = tripId();
    const [a, b] = await Promise.all([
      redeem(code, USER_A, dupTrip),
      redeem(code, USER_A, dupTrip),
    ]);
    expect(a.redemptionId).toBe(b.redemptionId);
    expect(await prisma.promoRedemption.count()).toBe(1);
  });
});
