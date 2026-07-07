/**
 * Over-redemption de promos · E2E con Postgres REAL (testcontainers) — el presupuesto de un cupón es un
 * invariante de DINERO (cada canje descuenta plata que absorbe la plataforma). Sin mock de DB (CLAUDE: pagos
 * NO se mockean). Gate auditar-core · ALTA: redeemPromo contaba usos FUERA de la tx (sobre la réplica) y luego
 * insertaba; dos canjes CONCURRENTES del mismo cupón (viajes/usuarios distintos) leían ambos por-debajo del cap
 * e insertaban (el UNIQUE por tripleta NO cubre el agregado) → se excedía maxTotalUses/maxUsesPerUser.
 *
 * Fix: advisory lock TRANSACCIONAL por promo (pg_advisory_xact_lock) + count DENTRO de la tx → el 2º canje espera
 * el commit del 1º y ve su inserción. Este suite prueba la carrera real contra PG (Promise.all de dos redeems).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { PromotionsService } from '../src/promotions/promotions.service';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let promotions: PromotionsService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // read y write al MISMO cliente del contenedor (el advisory lock necesita PG real, no un doble).
  promotions = new PromotionsService({ read: prisma, write: prisma } as unknown as PrismaService);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.promoRedemption.deleteMany({});
  await prisma.promotion.deleteMany({});
});

/** Siembra una promo FIXED (descuento fijo) con los caps pedidos. Devuelve su id. */
async function seedPromo(over: {
  code: string;
  maxTotalUses: number;
  maxUsesPerUser: number;
}): Promise<string> {
  const id = uuidv7();
  await prisma.promotion.create({
    data: {
      id,
      code: over.code,
      kind: 'FIXED',
      value: 1000, // 1000 céntimos de descuento fijo
      minFareCents: 0,
      maxTotalUses: over.maxTotalUses,
      maxUsesPerUser: over.maxUsesPerUser,
      active: true,
    },
  });
  return id;
}

describe('redeemPromo · over-redemption bajo concurrencia (advisory lock)', () => {
  it('maxTotalUses=1: dos canjes CONCURRENTES del mismo cupón (viajes distintos) → solo UNO gana, count=1', async () => {
    const promoId = await seedPromo({ code: 'TOTAL1', maxTotalUses: 1, maxUsesPerUser: 5 });

    const results = await Promise.allSettled([
      promotions.redeemPromo({
        code: 'TOTAL1',
        userId: uuidv7(),
        tripId: uuidv7(),
        fareCents: 5000,
        dedupKey: 'd-1',
      }),
      promotions.redeemPromo({
        code: 'TOTAL1',
        userId: uuidv7(),
        tripId: uuidv7(),
        fareCents: 5000,
        dedupKey: 'd-2',
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1); // el único uso lo toma UNO
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1); // el otro se rechaza por el cap
    const count = await prisma.promoRedemption.count({ where: { promotionId: promoId } });
    expect(count).toBe(1); // presupuesto NO excedido (antes del fix: 2)
  });

  it('maxUsesPerUser=1: dos canjes CONCURRENTES del MISMO usuario (viajes distintos) → solo UNO, count=1', async () => {
    const promoId = await seedPromo({ code: 'PERUSER1', maxTotalUses: 0, maxUsesPerUser: 1 }); // total ilimitado
    const userId = uuidv7();

    const results = await Promise.allSettled([
      promotions.redeemPromo({
        code: 'PERUSER1',
        userId,
        tripId: uuidv7(),
        fareCents: 5000,
        dedupKey: 'u-1',
      }),
      promotions.redeemPromo({
        code: 'PERUSER1',
        userId,
        tripId: uuidv7(),
        fareCents: 5000,
        dedupKey: 'u-2',
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const count = await prisma.promoRedemption.count({ where: { promotionId: promoId, userId } });
    expect(count).toBe(1); // el cap por usuario se respeta bajo concurrencia
  });

  it('secuencial dentro del cap → ambos canjes de usuarios distintos ganan (no rechaza de más)', async () => {
    const promoId = await seedPromo({ code: 'ROOM2', maxTotalUses: 2, maxUsesPerUser: 1 });

    await promotions.redeemPromo({
      code: 'ROOM2',
      userId: uuidv7(),
      tripId: uuidv7(),
      fareCents: 5000,
      dedupKey: 's-1',
    });
    await promotions.redeemPromo({
      code: 'ROOM2',
      userId: uuidv7(),
      tripId: uuidv7(),
      fareCents: 5000,
      dedupKey: 's-2',
    });

    const count = await prisma.promoRedemption.count({ where: { promotionId: promoId } });
    expect(count).toBe(2); // el lock serializa pero NO bloquea canjes legítimos dentro del presupuesto
  });
});
