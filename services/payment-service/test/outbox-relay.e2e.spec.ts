/**
 * E2E con Postgres REAL (testcontainers) del relay del outbox (@veo/database PrismaOutboxStore).
 *
 * Invariante crítico (regla 3 / BR-S05): con réplicas:2+, el relay corre en CADA pod. Sin lock, ambos
 * drenarían las MISMAS filas → doble publish (doble SMS de pánico, doble cobro aguas abajo). El advisory
 * lock (`pg_try_advisory_xact_lock` por schema) garantiza que solo UNA réplica drene a la vez. Acá lo
 * probamos con DOS `drainLocked` concurrentes sobre conexiones distintas (simula 2 pods): cada evento
 * debe publicarse EXACTAMENTE una vez.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { PrismaOutboxStore } from '@veo/database';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;

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

describe('OutboxRelay · drainLocked seguro en multi-réplica (advisory lock)', () => {
  it('dos drainLocked concurrentes → cada evento se publica EXACTAMENTE una vez (sin doble fan-out)', async () => {
    const N = 6;
    for (let i = 0; i < N; i++) {
      await prisma.outboxEvent.create({
        data: {
          aggregateId: `agg-${i}`,
          eventType: 'payment.captured',
          envelope: { eventType: 'payment.captured', eventId: uuidv7(), payload: { i } },
        },
      });
    }

    // Mismo client, pero $transaction toma conexiones distintas del pool → simula 2 réplicas.
    const store = new PrismaOutboxStore(prisma, 'payment');
    const publishedA: string[] = [];
    const publishedB: string[] = [];
    // Delay dentro del publish para FORZAR el solape: el 1ro sostiene el lock mientras el 2do intenta.
    const slowPublish =
      (acc: string[]) =>
      async (r: { id: string }): Promise<void> => {
        acc.push(r.id);
        await new Promise((res) => setTimeout(res, 25));
      };

    const [countA, countB] = await Promise.all([
      store.drainLocked(100, slowPublish(publishedA)),
      store.drainLocked(100, slowPublish(publishedB)),
    ]);

    // Uno drena los N, el otro obtiene el lock en false → 0. La suma es N, sin duplicados.
    expect(countA + countB).toBe(N);
    const all = [...publishedA, ...publishedB];
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N); // ningún id publicado dos veces

    // Todos quedaron marcados como publicados.
    const pendientes = await prisma.outboxEvent.count({ where: { publishedAt: null } });
    expect(pendientes).toBe(0);
  });

  it('un publish que falla → rollback: el evento queda SIN publicar para reintentar (no se pierde)', async () => {
    const created = await prisma.outboxEvent.create({
      data: {
        aggregateId: 'agg-fail',
        eventType: 'payment.refunded',
        envelope: { eventType: 'payment.refunded', eventId: uuidv7(), payload: {} },
      },
    });
    const store = new PrismaOutboxStore(prisma, 'payment');

    await expect(
      store.drainLocked(100, async () => {
        throw new Error('Kafka caído');
      }),
    ).rejects.toThrow('Kafka caído');

    // El rollback dejó la fila SIN publishedAt → se reintenta en el próximo tick.
    const row = await prisma.outboxEvent.findUnique({ where: { id: created.id } });
    expect(row?.publishedAt).toBeNull();
  });
});
