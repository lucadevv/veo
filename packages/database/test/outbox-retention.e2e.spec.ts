/**
 * E2E con Postgres REAL (testcontainers) de la RETENCIÓN del outbox (FIX: la tabla `outbox_events` crecía
 * sin límite — nadie borraba las filas PUBLICADAS). Un mock NO caza lo que importa acá: el DELETE real, el
 * filtro `published_at IS NOT NULL AND < cutoff`, el LIMIT del lote y el `FOR UPDATE SKIP LOCKED` (disjunción
 * multi-réplica + no-deadlock). Por eso va contra un Postgres efímero con la tabla real.
 *
 * Cubre:
 *  - borra SOLO publicadas viejas (publishedAt != NULL AND publishedAt < cutoff);
 *  - PRESERVA pendientes (publishedAt NULL), POISON terminal (failedAt set, publishedAt NULL) y publicadas
 *    RECIENTES (dentro de la ventana de retención);
 *  - es ACOTADO por lote (un solo sweepPublished borra a lo sumo `batch`);
 *  - es CONCURRENTE-SEGURO: dos sweeps en paralelo (simulan 2 réplicas) borran lotes DISJUNTOS vía SKIP
 *    LOCKED, sin doble-borrado y sin deadlock.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@veo/database/testing';
import { PrismaOutboxStore } from '../src/outbox.js';
import { PrismaClient } from './generated/prisma/index.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = 'outbox_test';

let db: TestDatabase;
let client: PrismaClient;
let store: PrismaOutboxStore;

/** Crea la tabla real (schema `outbox_test`) aplicando el schema de test con `prisma db push`. */
async function pushSchema(databaseUrl: string): Promise<void> {
  await execFileAsync(
    'pnpm',
    [
      'exec',
      'prisma',
      'db',
      'push',
      '--schema',
      join(HERE, 'prisma', 'schema.prisma'),
      '--skip-generate',
    ],
    { cwd: join(HERE, '..'), env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
}

/**
 * Inserta una fila directa por SQL (controla published_at/failed_at/created_at exactos para los cutoffs).
 * `publishedAgoMs` / `createdAgoMs`: cuántos ms ATRÁS respecto a now(). null = la columna queda NULL.
 */
async function insertRow(opts: {
  aggregateId: string;
  publishedAgoMs?: number | null;
  failedAgoMs?: number | null;
  claimedAgoMs?: number | null;
  createdAgoMs?: number;
}): Promise<string> {
  const {
    aggregateId,
    publishedAgoMs = null,
    failedAgoMs = null,
    claimedAgoMs = null,
    createdAgoMs = 0,
  } = opts;
  const rows = await client.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "${SCHEMA}"."outbox_events"
       (aggregate_id, event_type, envelope, created_at, published_at, failed_at, claimed_at)
     VALUES (
       $1, 'trip.requested', '{}'::jsonb,
       now() - ($2::double precision * interval '1 millisecond'),
       CASE WHEN $3::double precision IS NULL THEN NULL ELSE now() - ($3::double precision * interval '1 millisecond') END,
       CASE WHEN $4::double precision IS NULL THEN NULL ELSE now() - ($4::double precision * interval '1 millisecond') END,
       CASE WHEN $5::double precision IS NULL THEN NULL ELSE now() - ($5::double precision * interval '1 millisecond') END
     )
     RETURNING id`,
    aggregateId,
    createdAgoMs,
    publishedAgoMs,
    failedAgoMs,
    claimedAgoMs,
  );
  return rows[0]!.id;
}

async function countRows(): Promise<number> {
  const r = await client.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "${SCHEMA}"."outbox_events"`,
  );
  return Number(r[0]!.n);
}

async function idsLeft(): Promise<Set<string>> {
  const r = await client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "${SCHEMA}"."outbox_events"`,
  );
  return new Set(r.map((x) => x.id));
}

beforeAll(async () => {
  db = await createTestDatabase({ schema: SCHEMA });
  await pushSchema(db.databaseUrl);
  client = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await client.$connect();
  store = new PrismaOutboxStore(client as never, SCHEMA);
}, 180_000);

afterAll(async () => {
  await client?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await client.$executeRawUnsafe(`TRUNCATE "${SCHEMA}"."outbox_events"`);
});

describe('PrismaOutboxStore.sweepPublished · retención (Postgres real)', () => {
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
  const DAY = 24 * 60 * 60 * 1000;

  it('borra SOLO filas publicadas VIEJAS; preserva pendientes, poison y publicadas recientes', async () => {
    // Publicada VIEJA (10 días atrás > 7d retención) → DEBE borrarse.
    const oldPublished = await insertRow({
      aggregateId: 'a',
      publishedAgoMs: 10 * DAY,
      createdAgoMs: 10 * DAY,
    });
    // Publicada RECIENTE (1 día atrás < 7d) → DEBE quedar.
    const recentPublished = await insertRow({
      aggregateId: 'b',
      publishedAgoMs: 1 * DAY,
      createdAgoMs: 1 * DAY,
    });
    // PENDIENTE (publishedAt NULL, vieja) → DEBE quedar (aún no entregada a Kafka).
    const pending = await insertRow({
      aggregateId: 'c',
      publishedAgoMs: null,
      createdAgoMs: 10 * DAY,
    });
    // CLAIMED en vuelo (publishedAt NULL) → DEBE quedar.
    const claimed = await insertRow({
      aggregateId: 'd',
      publishedAgoMs: null,
      claimedAgoMs: 1000,
      createdAgoMs: 10 * DAY,
    });
    // POISON terminal (failedAt set, publishedAt NULL, viejo) → DEBE quedar (Ops investiga; nunca se barre).
    const poison = await insertRow({
      aggregateId: 'e',
      publishedAgoMs: null,
      failedAgoMs: 10 * DAY,
      createdAgoMs: 10 * DAY,
    });

    const deleted = await store.sweepPublished(RETENTION_MS, 1000);
    expect(deleted).toBe(1); // solo la publicada vieja

    const left = await idsLeft();
    expect(left.has(oldPublished)).toBe(false); // borrada
    expect(left.has(recentPublished)).toBe(true);
    expect(left.has(pending)).toBe(true);
    expect(left.has(claimed)).toBe(true);
    expect(left.has(poison)).toBe(true);
    expect(left.size).toBe(4);
  });

  it('es ACOTADO por lote: un sweepPublished borra a lo sumo `batch` (loop hasta vaciar)', async () => {
    // 5 publicadas viejas, lote = 2.
    for (let i = 0; i < 5; i++) {
      await insertRow({
        aggregateId: `agg-${i}`,
        publishedAgoMs: 10 * DAY,
        createdAgoMs: 10 * DAY,
      });
    }
    expect(await countRows()).toBe(5);

    // Cada llamada borra exactamente el tope del lote hasta que el resto < batch.
    expect(await store.sweepPublished(RETENTION_MS, 2)).toBe(2);
    expect(await store.sweepPublished(RETENTION_MS, 2)).toBe(2);
    expect(await store.sweepPublished(RETENTION_MS, 2)).toBe(1); // < batch ⇒ no quedan más
    expect(await store.sweepPublished(RETENTION_MS, 2)).toBe(0);
    expect(await countRows()).toBe(0);
  });

  it('CONCURRENTE (2 réplicas): SKIP LOCKED ⇒ lotes disjuntos, sin doble-borrado ni deadlock', async () => {
    // 200 publicadas viejas; dos sweeps en paralelo con lote 50.
    const total = 200;
    for (let i = 0; i < total; i++) {
      await insertRow({
        aggregateId: `agg-${i}`,
        publishedAgoMs: 10 * DAY,
        createdAgoMs: 10 * DAY,
      });
    }
    // Loop de barrido por "réplica" (igual que el relay): borra en lotes hasta vaciar.
    const sweepLoop = async (): Promise<number> => {
      let n = 0;
      for (;;) {
        const d = await store.sweepPublished(RETENTION_MS, 50);
        n += d;
        if (d === 0) break;
      }
      return n;
    };
    const [a, b] = await Promise.all([sweepLoop(), sweepLoop()]);
    // Suma exacta = total (cero doble-borrado: una fila la borra UNA sola réplica). Sin deadlock (no lanzó).
    expect(a + b).toBe(total);
    expect(await countRows()).toBe(0);
  });

  it('idempotente: re-barrer sin filas viejas borra 0', async () => {
    await insertRow({ aggregateId: 'a', publishedAgoMs: 1 * DAY, createdAgoMs: 1 * DAY }); // reciente, no se toca
    expect(await store.sweepPublished(RETENTION_MS, 1000)).toBe(0);
    expect(await countRows()).toBe(1);
  });
});
