/**
 * Spec del OutboxRelay promovido (el esqueleto común de las 12 copias por-servicio).
 * Con fakes (prisma estructural + producer inyectado) y timers falsos: el lock multi-réplica
 * y el rollback transaccional REALES se cubren en el e2e con Postgres de payment-service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type EventEnvelope, type KafkaEventProducer } from '@veo/events';
import {
  OutboxRelay,
  OUTBOX_RELAY_BATCH_SIZE,
  OUTBOX_RELAY_TICK_MS,
  type OutboxRelayLogger,
} from './outbox-relay.js';
import type { OutboxPrismaClient, OutboxTxClient } from './outbox.js';

interface Row {
  id: string;
  aggregateId: string;
  eventType: string;
  envelope: unknown;
  createdAt: Date;
  publishedAt: Date | null;
}

/** Cliente Prisma fake en memoria que satisface el OutboxPrismaClient estructural. */
function fakeOutboxClient(rows: Row[]): OutboxPrismaClient {
  const tx: OutboxTxClient = {
    $queryRaw: async <T>() => [{ locked: true }] as T,
    outboxEvent: {
      create: async () => ({}),
      findMany: async ({ take }) =>
        rows
          .filter((r) => r.publishedAt === null)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take),
      updateMany: async ({ where, data }) => {
        for (const r of rows) {
          if (where.id.in.includes(r.id)) r.publishedAt = data.publishedAt;
        }
        return {};
      },
    },
  };
  return { ...tx, $transaction: async (fn) => fn(tx) };
}

function row(i: number, eventType = 'trip.requested'): Row {
  return {
    id: `id-${i}`,
    aggregateId: `agg-${i}`,
    eventType,
    envelope: createEnvelope({ eventType, producer: 'trip-service', payload: { i } }),
    createdAt: new Date(2026, 0, 1, 0, 0, i),
    publishedAt: null,
  };
}

function fakeProducer(): {
  published: Array<{ envelope: EventEnvelope<unknown>; key: string }>;
  publish: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  asKafkaProducer(): KafkaEventProducer;
} {
  const published: Array<{ envelope: EventEnvelope<unknown>; key: string }> = [];
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

function fakeLogger(): OutboxRelayLogger & { debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
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

  it('publish que falla → NO marca publishedAt (queda para reintentar) y loguea el error', async () => {
    const rows = [row(0)];
    const producer = fakeProducer();
    producer.publish.mockRejectedValueOnce(new Error('Kafka caído'));
    const logger = fakeLogger();
    const relay = relayWith(rows, producer, logger);

    await relay.onModuleInit();
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);

    expect(rows[0]!.publishedAt).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      { err: new Error('Kafka caído') },
      'outbox relay falló',
    );

    // El próximo tick reintenta y ahora sí publica.
    await vi.advanceTimersByTimeAsync(OUTBOX_RELAY_TICK_MS);
    expect(rows[0]!.publishedAt).toBeInstanceOf(Date);
    expect(producer.published.map((p) => p.key)).toEqual(['agg-0']);

    await relay.onModuleDestroy();
  });

  it('respeta el batchSize por tick (default histórico: 100)', async () => {
    expect(OUTBOX_RELAY_BATCH_SIZE).toBe(100);
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
