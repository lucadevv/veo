/**
 * Spec del OutboxRelay promovido (el esqueleto común de las 12 copias por-servicio).
 * Con fakes (prisma estructural + producer inyectado) y timers falsos: el lock multi-réplica
 * y el rollback transaccional REALES se cubren en el e2e con Postgres de payment-service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type EventEnvelope, type KafkaEventProducer } from '@veo/events';
import {
  OutboxRelay,
  OUTBOX_BATCH_SIZE,
  OUTBOX_RELAY_TICK_MS,
  type OutboxRelayLogger,
} from './outbox-relay.js';
import type { OutboxPrismaClient } from './outbox.js';

interface Row {
  id: string;
  aggregateId: string;
  eventType: string;
  envelope: unknown;
  createdAt: Date;
  publishedAt: Date | null;
  claimedAt: Date | null;
}

/**
 * Cliente Prisma fake en memoria que satisface el OutboxPrismaClient estructural (3 fases claim→ack).
 * Interpreta las dos formas de SQL raw que emite el store: el CLAIM (`UPDATE ... SET claimed_at`, devuelve
 * filas) y el ACK (`SET published_at` / `SET claimed_at = NULL` sobre un array de ids). No es un parser SQL:
 * matchea por substring estable del SQL del store, suficiente para cubrir el esqueleto del relay con timers
 * falsos (el CLAIM real con SKIP LOCKED / stale-reclaim se prueba en el e2e con Postgres).
 */
function fakeOutboxClient(rows: Row[]): OutboxPrismaClient {
  return {
    outboxEvent: { create: async () => ({}) },
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]): Promise<T> => {
      // CLAIM: reclama hasta `limit` pendientes no-claimed (o claim stale), ordenados por createdAt.
      const [, limit] = values as [number, number];
      const now = Date.now();
      const claimed = rows
        .filter((r) => r.publishedAt === null && r.claimedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit);
      for (const r of claimed) r.claimedAt = new Date(now);
      return claimed.map((r) => ({
        id: r.id,
        aggregate_id: r.aggregateId,
        envelope: r.envelope,
        created_at: r.createdAt,
      })) as T;
    },
    $executeRawUnsafe: async (query: string, ...values: unknown[]): Promise<number> => {
      const ids = values[0] as string[];
      const setPublished = query.includes('published_at = now()');
      let n = 0;
      for (const r of rows) {
        if (!ids.includes(r.id)) continue;
        if (setPublished) r.publishedAt = new Date();
        else r.claimedAt = null; // reset de claim para fallos transitorios
        n++;
      }
      return n;
    },
  };
}

function row(i: number, eventType = 'trip.requested'): Row {
  return {
    id: `id-${i}`,
    aggregateId: `agg-${i}`,
    eventType,
    envelope: createEnvelope({ eventType, producer: 'trip-service', payload: { i } }),
    createdAt: new Date(2026, 0, 1, 0, 0, i),
    publishedAt: null,
    claimedAt: null,
  };
}

function fakeProducer(): {
  published: { envelope: EventEnvelope<unknown>; key: string }[];
  publish: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  asKafkaProducer(): KafkaEventProducer;
} {
  const published: { envelope: EventEnvelope<unknown>; key: string }[] = [];
  const fake = {
    published,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    publish: vi.fn(async (envelope: EventEnvelope<unknown>, key: string) => {
      published.push({ envelope, key });
    }),
    asKafkaProducer(): KafkaEventProducer {
      return fake as unknown as KafkaEventProducer;
    },
  };
  return fake;
}

function fakeLogger(): OutboxRelayLogger & {
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { debug: vi.fn(), error: vi.fn() };
}

function relayWith(
  rows: Row[],
  producer: ReturnType<typeof fakeProducer>,
  logger: OutboxRelayLogger,
  extra?: { batchSize?: number; retention?: (n: number) => Promise<void> | void },
): OutboxRelay {
  return new OutboxRelay({
    clientId: 'trip-service',
    brokers: ['localhost:9092'],
    schema: 'trip',
    prisma: fakeOutboxClient(rows),
    logger,
    producer: producer.asKafkaProducer(),
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxRelay · invariante publishTimeoutMs < claimStaleMs (fail-fast anti double-publish)', () => {
  it('LANZA en el ctor si publishTimeoutMs >= claimStaleMs (una mala config NO arranca)', () => {
    const opts = {
      clientId: 'trip-service',
      brokers: ['localhost:9092'],
      schema: 'trip',
      prisma: fakeOutboxClient([]),
      logger: fakeLogger(),
      producer: fakeProducer().asKafkaProducer(),
    };
    // timeout == stale → inválido (debe ser ESTRICTAMENTE menor).
    expect(() => new OutboxRelay({ ...opts, claimStaleMs: 30_000, publishTimeoutMs: 30_000 })).toThrow(
      /publishTimeoutMs.*debe ser <.*claimStaleMs/,
    );
    // timeout > stale → inválido.
    expect(() => new OutboxRelay({ ...opts, claimStaleMs: 10_000, publishTimeoutMs: 30_000 })).toThrow(
      /publishTimeoutMs/,
    );
    // timeout < stale → OK (no lanza). Defaults: 30_000 < 60_000.
    expect(() => new OutboxRelay({ ...opts })).not.toThrow();
    expect(() => new OutboxRelay({ ...opts, claimStaleMs: 60_000, publishTimeoutMs: 30_000 })).not.toThrow();
  });
});

describe('OutboxRelay (helper promovido a @veo/database)', () => {
  it('conecta el producer al init y publica el batch pendiente marcando publishedAt', async () => {
    const rows = [row(0), row(1), row(2)];
    const producer = fakeProducer();
    const logger = fakeLogger();
    const relay = relayWith(rows, producer, logger);

    await relay.onModuleInit();
    expect(producer.connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);

    // Publica con la key Kafka = aggregateId (ordena por entidad), en orden de creación.
    expect(producer.published.map((p) => p.key)).toEqual(['agg-0', 'agg-1', 'agg-2']);
    expect(rows.every((r) => r.publishedAt instanceof Date)).toBe(true);
    // Log estructurado idéntico al histórico.
    expect(logger.debug).toHaveBeenCalledWith('outbox: publicados 3 eventos');
    expect(logger.error).not.toHaveBeenCalled();

    await relay.onModuleDestroy();
    expect(producer.disconnect).toHaveBeenCalledOnce();
  });

  it('publish que falla → NO marca publishedAt (claim reseteado, retry el próximo tick) SIN tirar el tick', async () => {
    const rows = [row(0)];
    const producer = fakeProducer();
    producer.publish.mockRejectedValueOnce(new Error('Kafka caído'));
    const logger = fakeLogger();
    const relay = relayWith(rows, producer, logger);

    await relay.onModuleInit();
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);

    // Desacople: un publish que falla se AÍSLA (ack resetea claimed_at, la fila queda pendiente). Ya NO tira
    // el tick entero con rollback (causa raíz del thrashing previo) → no hay error log para un fallo transitorio.
    expect(rows[0]!.publishedAt).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();

    // El próximo tick re-reclama (claimed_at quedó NULL) y ahora sí publica.
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    expect(rows[0]!.publishedAt).toBeInstanceOf(Date);
    expect(producer.published.map((p) => p.key)).toEqual(['agg-0']);

    await relay.onModuleDestroy();
  });

  it('respeta el batchSize por tick (default histórico: 100)', async () => {
    expect(OUTBOX_BATCH_SIZE).toBe(100);
    const rows = [row(0), row(1), row(2), row(3), row(4)];
    const producer = fakeProducer();
    const relay = relayWith(rows, producer, fakeLogger(), { batchSize: 2 });

    await relay.onModuleInit();
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    // Solo los 2 más antiguos en el primer tick.
    expect(producer.published.map((p) => p.key)).toEqual(['agg-0', 'agg-1']);

    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    expect(producer.published).toHaveLength(4);

    await relay.onModuleDestroy();
  });

  it('seam de retención: se invoca al final de cada tick exitoso con lo publicado en el tick', async () => {
    const rows = [row(0), row(1)];
    const producer = fakeProducer();
    const retention = vi.fn(async () => {});
    const relay = relayWith(rows, producer, fakeLogger(), { retention });

    await relay.onModuleInit();
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    expect(retention).toHaveBeenLastCalledWith(2);

    // Tick sin pendientes: el hook igual corre (puede borrar publicados viejos).
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    expect(retention).toHaveBeenLastCalledWith(0);

    await relay.onModuleDestroy();
  });
});
