/**
 * E2E con Postgres REAL (testcontainers) del relay del outbox (@veo/database PrismaOutboxStore, 3 fases).
 *
 * Esta es la verificación CANÓNICA del desacople CLAIM → PUBLISH → ACK contra Postgres real (el mock NO caza
 * SKIP LOCKED, ni el stale-reclaim, ni que el publish corra fuera de la tx). Vive en payment-service porque es
 * el servicio con harness Postgres+Prisma+migraciones ya montado (incluye la migración `outbox_claim_marker`
 * que agrega `claimed_at`). El store es genérico (@veo/database) → lo aquí probado aplica a los 13 servicios.
 *
 * Cubre los invariantes del diseño:
 *   (a) CLAIM concurrente de 2 réplicas → lotes DISJUNTOS (SKIP LOCKED + claimed_at), cero doble-publish.
 *   (b) el PUBLISH NO corre dentro de una tx (otra query a la tabla no se bloquea durante el publish).
 *   (c) stale-reclaim: claim viejo (> stale) se re-toma; claim reciente NO.
 *   (d) ORDEN per-aggregate: eventos del mismo aggregate se publican en orden createdAt.
 *   (e) ACK marca published los éxitos y resetea claimed_at = NULL los fallos.
 *   (f) at-least-once: ack que falla tras publish OK → la fila se re-publica (no se pierde).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { PrismaOutboxStore } from '@veo/database';
import { createEnvelope, schemaForEvent, type EventEnvelope } from '@veo/events';
import { uuidv7 } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

const STALE_MS = 60_000;
const CONCURRENCY = 8;
const BATCH = 100;

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

afterEach(async () => {
  // Aislamiento entre tests: la tabla outbox arranca vacía en cada caso.
  await prisma.outboxEvent.deleteMany({});
});

function envelope() {
  return { eventType: 'payment.captured', eventId: uuidv7(), payload: {} };
}

async function seed(aggregateId: string, count = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await prisma.outboxEvent.create({
      data: { aggregateId, eventType: 'payment.captured', envelope: envelope() },
    });
    ids.push(row.id);
  }
  return ids;
}

describe('OutboxRelay · drain de 3 fases (claim → publish → ack) sobre Postgres real', () => {
  it('(a) dos drain concurrentes → lotes DISJUNTOS por SKIP LOCKED, cada evento publicado EXACTAMENTE una vez', async () => {
    const N = 6;
    for (let i = 0; i < N; i++) await seed(`agg-${i}`);

    const store = new PrismaOutboxStore(prisma, 'payment');
    const publishedA: string[] = [];
    const publishedB: string[] = [];
    // Delay en el publish para FORZAR el solape de los dos drains (claim disjunto, publish concurrente).
    const slowPublish =
      (acc: string[]) =>
      async (r: { id: string }): Promise<void> => {
        acc.push(r.id);
        await new Promise((res) => setTimeout(res, 25));
      };

    const [countA, countB] = await Promise.all([
      store.drain(BATCH, STALE_MS, CONCURRENCY, slowPublish(publishedA)),
      store.drain(BATCH, STALE_MS, CONCURRENCY, slowPublish(publishedB)),
    ]);

    expect(countA.published + countB.published).toBe(N);
    const all = [...publishedA, ...publishedB];
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N); // ningún id publicado dos veces
    expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
  });

  it('(b) el PUBLISH corre AFUERA de la tx: durante el publish, otra query a la tabla NO se bloquea', async () => {
    await seed('agg-nontx', 3);
    const store = new PrismaOutboxStore(prisma, 'payment');

    let queryDuringPublishMs = -1;
    const drainPromise = store.drain(BATCH, STALE_MS, CONCURRENCY, async () => {
      // Mientras estamos "publicando", una query independiente a la tabla debe responder rápido
      // (si el claim sostuviera una tx larga con lock, esto se bloquearía hasta el commit).
      const t0 = Date.now();
      await prisma.outboxEvent.count({});
      const elapsed = Date.now() - t0;
      if (queryDuringPublishMs < 0) queryDuringPublishMs = elapsed;
      await new Promise((res) => setTimeout(res, 50));
    });

    await drainPromise;
    expect(queryDuringPublishMs).toBeGreaterThanOrEqual(0);
    expect(queryDuringPublishMs).toBeLessThan(1000); // no quedó esperando un lock/tx larga
  });

  it('(c) stale-reclaim: un claim viejo (> stale) se re-toma; uno reciente NO', async () => {
    const [staleId] = await seed('agg-stale');
    const [freshId] = await seed('agg-fresh');

    // Marca staleId como reclamado HACE MUCHO (claim huérfano de un proceso muerto) y freshId recién.
    await prisma.$executeRawUnsafe(
      `UPDATE "payment"."outbox_events" SET claimed_at = now() - interval '10 minutes' WHERE id = $1::uuid`,
      staleId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "payment"."outbox_events" SET claimed_at = now() WHERE id = $1::uuid`,
      freshId,
    );

    const store = new PrismaOutboxStore(prisma, 'payment');
    const published: string[] = [];
    await store.drain(BATCH, STALE_MS, CONCURRENCY, async (r) => {
      published.push(r.id);
    });

    expect(published).toContain(staleId); // recuperado: el claim quedó stale
    expect(published).not.toContain(freshId); // claim reciente → otra réplica lo tiene, no se re-toma
  });

  it('(d) ORDEN per-aggregate: 3 eventos del mismo aggregate se publican en orden createdAt', async () => {
    // created_at EXPLÍCITO y estrictamente creciente: el default (CURRENT_TIMESTAMP = hora de tx) puede
    // empatar entre inserts del mismo loop, y con empate el ORDER BY created_at no es determinista. El store
    // ordena por created_at; acá garantizamos created_at distintos para verificar el orden per-aggregate.
    const a: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await prisma.outboxEvent.create({
        data: {
          aggregateId: 'AAA',
          eventType: 'payment.captured',
          envelope: envelope(),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        },
      });
      a.push(row.id);
    }
    await seed('BBB', 2);

    const store = new PrismaOutboxStore(prisma, 'payment');
    const orderA: string[] = [];
    await store.drain(BATCH, STALE_MS, CONCURRENCY, async (r) => {
      if (r.aggregateId === 'AAA') orderA.push(r.id);
      await new Promise((res) => setTimeout(res, 5)); // fuerza intercalado entre AAA y BBB
    });

    expect(orderA).toEqual(a); // serial dentro del grupo pese al paralelismo entre aggregates
  });

  it('(e) ACK: marca published los éxitos y resetea claimed_at = NULL los fallos', async () => {
    const [okId] = await seed('agg-ok');
    const [failId] = await seed('agg-fail');

    const store = new PrismaOutboxStore(prisma, 'payment');
    await store.drain(BATCH, STALE_MS, CONCURRENCY, async (r) => {
      if (r.aggregateId === 'agg-fail') throw new Error('Kafka caído');
    });

    const ok = await prisma.outboxEvent.findUnique({ where: { id: okId } });
    const fail = await prisma.outboxEvent.findUnique({ where: { id: failId } });
    expect(ok?.publishedAt).toBeInstanceOf(Date); // éxito → published
    expect(fail?.publishedAt).toBeNull(); // fallo → no published
    expect(fail?.claimedAt).toBeNull(); // y claim reseteado → retry inmediato el próximo tick
  });

  it('(f) at-least-once: ack que falla tras publish OK → la fila queda claimed → stale-reclaim la re-publica', async () => {
    const [id] = await seed('agg-atleastonce');
    const store = new PrismaOutboxStore(prisma, 'payment');

    // Simula crash entre claim y ack: el publish sale OK pero el proceso "muere" antes del ack.
    // Lo modelamos reclamando la fila a mano y publicándola, SIN ackear (la fila queda claimed, no published).
    await prisma.$executeRawUnsafe(
      `UPDATE "payment"."outbox_events" SET claimed_at = now() - interval '10 minutes' WHERE id = $1::uuid`,
      id,
    );
    // (en el mundo real Kafka ya recibió el evento; el consumer es idempotente vía dedupKey)

    // El stale-reclaim del próximo tick re-toma la fila (claim viejo) y la re-publica → at-least-once.
    const republished: string[] = [];
    const result = await store.drain(BATCH, STALE_MS, CONCURRENCY, async (r) => {
      republished.push(r.id);
    });

    expect(result.published).toBe(1);
    expect(republished).toEqual([id]); // se re-publicó (duplicado que el consumer idempotente descarta)
    const row = await prisma.outboxEvent.findUnique({ where: { id } });
    expect(row?.publishedAt).toBeInstanceOf(Date); // ahora sí queda published tras el ack
  });
});

/**
 * Siembra una fila outbox con created_at y eventId EXPLÍCITOS (raw SQL para fijarlos). El `payload` se persiste
 * tal cual: un payload inválido para el schema del eventType producirá el poison al validar en el publish.
 */
async function seedRaw(opts: {
  aggregateId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  eventId?: string;
  /** seq EXPLÍCITO (override del default nextval). Para fijar el orden de inserción a mano en los tests de orden. */
  seq?: bigint;
}): Promise<string> {
  const eventId = opts.eventId ?? uuidv7();
  const env: EventEnvelope<unknown> = {
    ...createEnvelope({ eventType: opts.eventType, producer: 'payment-service', payload: opts.payload }),
    eventId,
  };
  if (opts.seq !== undefined) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "payment"."outbox_events" (id, seq, aggregate_id, event_type, envelope, created_at)
       VALUES (gen_random_uuid(), $1::bigint, $2, $3, $4::jsonb, $5)`,
      opts.seq.toString(),
      opts.aggregateId,
      opts.eventType,
      JSON.stringify(env),
      opts.createdAt,
    );
  } else {
    // Sin seq explícito → la columna usa su default `nextval(...)`: el seq sigue el ORDEN DE INSERCIÓN (orden
    // de las llamadas a seedRaw), que es justo la garantía monotónica que el fix provee.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "payment"."outbox_events" (id, aggregate_id, event_type, envelope, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4)`,
      opts.aggregateId,
      opts.eventType,
      JSON.stringify(env),
      opts.createdAt,
    );
  }
  return eventId;
}

/** `publish` que replica el camino del KafkaEventProducer.publish: valida con el schema del registro (ZodError
 *  = poison) y si valida registra el eventId publicado (no-op Kafka). */
function validatingPublish(publishedEventIds: string[]) {
  return async (r: { envelope: EventEnvelope<unknown> }): Promise<void> => {
    const schema = schemaForEvent(r.envelope.eventType);
    if (schema) schema.parse(r.envelope.payload); // lanza ZodError si el payload es inválido
    publishedEventIds.push(r.envelope.eventId);
  };
}

describe('OutboxRelay e2e (Postgres real) · migraciones CONCURRENTLY aplicadas sin tx', () => {
  it('el índice de claim con seq existe y los previos (sin seq) fueron dropeados → las CONCURRENTLY corrieron', async () => {
    // Si una CONCURRENTLY hubiera estado envuelta en tx, el `migrate deploy` del beforeAll habría LANZADO y
    // ningún test correría. Que lleguemos acá ya prueba que aplicaron; lo afirmamos leyendo pg_indexes.
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'outbox_events'`,
      'payment',
    );
    const names = idx.map((i) => i.indexname);
    // El índice VIGENTE: (published_at, failed_at, claimed_at, created_at, seq), nombrado `outbox_events_claim_idx`
    // (vía @@index(map:) → nombre corto fijo, sin el truncado de 63 chars de un autogenerado de 6 columnas).
    expect(names).toContain('outbox_events_claim_idx');
    // Los índices de claim PREVIOS (sin seq) fueron dropeados CONCURRENTLY (el de 4 col en 20260624000400, y el
    // original de 2 col aún antes).
    expect(names).not.toContain('outbox_events_published_at_failed_at_claimed_at_created_at_idx');
    expect(names).not.toContain('outbox_events_published_at_created_at_idx');
  });

  it('la columna seq existe, es NOT NULL y tiene default nextval (la migración no-bloqueante del seq aplicó)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'outbox_events' AND column_name = 'seq'`,
      'payment',
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]!.is_nullable).toBe('NO'); // SET NOT NULL aplicó
    expect(cols[0]!.column_default ?? '').toContain('nextval'); // el default de inserción está cableado
  });
});

describe('OutboxRelay e2e (Postgres real) · FIX 1 — poison terminal NO bloquea el grupo per-aggregate', () => {
  it('poison en la CABEZA → se marca failed_at (terminal) y los SANOS siguientes del MISMO aggregate se publican', async () => {
    const AGG = '0192f8a0-0000-7000-8000-00000000a001';
    // Cabeza POISON: user.registered con NÚMEROS donde el schema exige strings → ZodError al publicar.
    const poisonId = await seedRaw({
      aggregateId: AGG,
      eventType: 'user.registered',
      payload: { userId: 123, phone: 456, kycStatus: 789 },
      createdAt: new Date('2026-06-24T00:00:01.000Z'),
    });
    const sane1 = await seedRaw({
      aggregateId: AGG,
      eventType: 'user.registered',
      payload: { userId: 'u1', phone: '+51999', kycStatus: 'VERIFIED' },
      createdAt: new Date('2026-06-24T00:00:02.000Z'),
    });
    const sane2 = await seedRaw({
      aggregateId: AGG,
      eventType: 'user.registered',
      payload: { userId: 'u2', phone: '+51888', kycStatus: 'VERIFIED' },
      createdAt: new Date('2026-06-24T00:00:03.000Z'),
    });

    const store = new PrismaOutboxStore(prisma, 'payment');
    const publishedEventIds: string[] = [];
    const result = await store.drain(BATCH, STALE_MS, CONCURRENCY, validatingPublish(publishedEventIds));

    // El grupo AVANZÓ pese al poison en la cabeza: los 2 sanos se publicaron.
    expect(result.published).toBe(2);
    expect(publishedEventIds).toEqual([sane1, sane2]);
    // El poison se reportó (para métrica/log del relay) con su eventType.
    expect(result.poisoned).toHaveLength(1);
    expect(result.poisoned[0]!.eventType).toBe('user.registered');
    void poisonId;

    // En la DB real: el poison quedó failed_at (terminal, claim liberado), no published.
    const all = await prisma.$queryRawUnsafe<
      { aggregate_id: string; published_at: Date | null; failed_at: Date | null; claimed_at: Date | null }[]
    >(
      `SELECT aggregate_id, published_at, failed_at, claimed_at FROM "payment"."outbox_events"
       WHERE failed_at IS NOT NULL`,
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.published_at).toBeNull();
    expect(all[0]!.claimed_at).toBeNull();

    // NO retry infinito: un segundo drain NO re-reclama el poison (failed_at lo excluye) ni publica nada.
    const published2: string[] = [];
    const result2 = await store.drain(BATCH, STALE_MS, CONCURRENCY, validatingPublish(published2));
    expect(result2.published).toBe(0);
    expect(result2.poisoned).toEqual([]);
    expect(published2).toEqual([]);
  });
});

describe('OutboxRelay e2e (Postgres real) · FIX seq — orden intra-tx DETERMINISTA por la secuencia monotónica', () => {
  /**
   * EL BUG QUE CIERRA (MEDIA, orden de eventos): dos eventos del MISMO aggregate emitidos en la MISMA tx
   * comparten `created_at` AL µs (default `now()` = transaction_timestamp). El tiebreak VIEJO por `eventId`
   * (uuidv7) era RANDOM dentro del mismo ms (RFC 9562 §5.7: la cola de 74 bits es aleatoria) → orden de
   * publicación no-determinista → el consumer (Kafka ordena por key=aggregateId según orden de PRODUCE) los veía
   * fuera de orden. El fix de RAÍZ: la columna `seq` (secuencia monotónica = orden de INSERCIÓN), que el store
   * usa como tiebreak `(created_at, seq)`. Inmune al clock y al uuid random.
   */
  it('mismo created_at + eventIds del MISMO ms (cola random): publica en orden de seq (inserción), NO del eventId', async () => {
    const AGG = '0192f8a0-0000-7000-8000-00000000a003';
    const sameInstant = new Date('2026-06-24T00:02:00.000Z');
    const ms = sameInstant.getTime();

    // 3 eventIds v7 GENERADOS EN EL MISMO ms → comparten el prefijo de 48 bits (timestamp) y SOLO difieren en la
    // cola random. El orden lexicográfico entre ellos es AZAR (no temporal). Construimos un caso ADVERSARIAL:
    // el orden de inserción (seq 1<2<3 = orden REAL de creación intra-tx) es OPUESTO al orden lexicográfico del
    // eventId, para que el tiebreak VIEJO (eventId) hubiera dado el orden INVERTIDO y este test lo CACE.
    const mkEvent = (tail: string) =>
      `0192f8a0-0000-7000-8000-${tail}`; // v7 válido con prefijo de ms fijo; tail controla el orden lexicográfico
    void ms;
    // Orden de creación intra-tx (lo que el negocio emitió): primero el de tail ALTO, después medio, después bajo.
    // → seq 1,2,3 sigue ESE orden; el eventId lexicográfico (tail) es 'fff' > 'aaa' > '000' = orden CONTRARIO.
    const first = mkEvent('00000000ffff'); // creado 1º → seq=1, pero eventId lexicográficamente el MÁS GRANDE
    const second = mkEvent('00000000aaaa'); // creado 2º → seq=2
    const third = mkEvent('000000000000'); // creado 3º → seq=3, eventId el MÁS CHICO
    const p = (u: string) => ({ userId: u, phone: '+51', kycStatus: 'V' });
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('u1'), createdAt: sameInstant, eventId: first, seq: 1n });
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('u2'), createdAt: sameInstant, eventId: second, seq: 2n });
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('u3'), createdAt: sameInstant, eventId: third, seq: 3n });

    const store = new PrismaOutboxStore(prisma, 'payment');
    const publishedEventIds: string[] = [];
    await store.drain(BATCH, STALE_MS, CONCURRENCY, validatingPublish(publishedEventIds));

    // DETERMINISTA por seq (orden de inserción) = [first, second, third].
    expect(publishedEventIds).toEqual([first, second, third]);
    // Y NO es el orden del eventId (que habría sido [third, second, first], el inverso). Esta línea es la que
    // FALLABA con el tiebreak viejo (eventId): demuestra que seq, no el eventId, manda.
    expect(publishedEventIds).not.toEqual([third, second, first]);
  });

  it('seq se autoasigna por nextval en orden de INSERCIÓN cuando no se fija a mano (default de la columna)', async () => {
    const AGG = '0192f8a0-0000-7000-8000-00000000a004';
    const sameInstant = new Date('2026-06-24T00:03:00.000Z');
    const p = (u: string) => ({ userId: u, phone: '+51', kycStatus: 'V' });
    // Sin seq explícito: el default nextval lo asigna en orden de inserción. eventIds del MISMO ms (cola random).
    const ms = sameInstant.getTime();
    const a = uuidv7(ms);
    const b = uuidv7(ms);
    const c = uuidv7(ms);
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('a'), createdAt: sameInstant, eventId: a });
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('b'), createdAt: sameInstant, eventId: b });
    await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p('c'), createdAt: sameInstant, eventId: c });

    const store = new PrismaOutboxStore(prisma, 'payment');
    const publishedEventIds: string[] = [];
    await store.drain(BATCH, STALE_MS, CONCURRENCY, validatingPublish(publishedEventIds));

    expect(publishedEventIds).toEqual([a, b, c]); // orden de inserción, determinista, pese a eventIds random del mismo ms
  });

  it('el CLAIM ordena el batch por (created_at, seq): el LIMIT corta DETERMINISTA en empate de created_at', async () => {
    // 5 eventos del mismo aggregate, MISMO created_at, seq 1..5. Con batch=3, el claim debe llevarse seq 1,2,3
    // (los 3 más bajos por seq) y dejar 4,5 para el próximo tick — corte REPRODUCIBLE pese al created_at empatado.
    const AGG = '0192f8a0-0000-7000-8000-00000000a005';
    const sameInstant = new Date('2026-06-24T00:04:00.000Z');
    const p = (u: string) => ({ userId: u, phone: '+51', kycStatus: 'V' });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const eid = uuidv7(sameInstant.getTime());
      ids.push(eid);
      await seedRaw({ aggregateId: AGG, eventType: 'user.registered', payload: p(`u${i}`), createdAt: sameInstant, eventId: eid, seq: BigInt(i) });
    }

    const store = new PrismaOutboxStore(prisma, 'payment');
    const firstBatch: string[] = [];
    await store.drain(3, STALE_MS, CONCURRENCY, validatingPublish(firstBatch));
    expect(firstBatch).toEqual([ids[0], ids[1], ids[2]]); // seq 1,2,3 — corte determinista

    const secondBatch: string[] = [];
    await store.drain(3, STALE_MS, CONCURRENCY, validatingPublish(secondBatch));
    expect(secondBatch).toEqual([ids[3], ids[4]]); // seq 4,5 — el resto, en orden
  });
});
