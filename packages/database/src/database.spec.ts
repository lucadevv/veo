import { describe, it, expect } from 'vitest';
import { ReadWriteClient, type PrismaLike } from './read-write.js';
import {
  enqueueOutbox,
  PrismaOutboxStore,
  type OutboxDelegate,
  type OutboxPrismaClient,
} from './outbox.js';
import { tombstone, deletedPlaceholder, type UpdatableDelegate } from './tombstone.js';
import { isUniqueViolation, isRecordNotFound } from './prisma-errors.js';
import { createEnvelope } from '@veo/events';

class FakeClient implements PrismaLike {
  connected = false;
  constructor(readonly options?: { datasourceUrl?: string }) {}
  async $connect() {
    this.connected = true;
  }
  async $disconnect() {
    this.connected = false;
  }
}

describe('ReadWriteClient', () => {
  it('sin readUrl, lecturas van al primary (mismo cliente)', async () => {
    const db = new ReadWriteClient(FakeClient, { writeUrl: 'postgres://primary' });
    expect(db.read).toBe(db.write);
    await db.connect();
    expect(db.write.connected).toBe(true);
  });

  it('con readUrl distinta, crea cliente de réplica separado y conecta ambos', async () => {
    const db = new ReadWriteClient(FakeClient, {
      writeUrl: 'postgres://primary',
      readUrl: 'postgres://replica',
    });
    expect(db.read).not.toBe(db.write);
    expect(db.read.options?.datasourceUrl).toBe('postgres://replica');
    await db.connect();
    expect(db.read.connected).toBe(true);
    await db.disconnect();
    expect(db.read.connected).toBe(false);
  });
});

describe('outbox', () => {
  it('enqueueOutbox inserta el envelope con aggregateId y eventType', async () => {
    const created: unknown[] = [];
    const delegate: OutboxDelegate = {
      async create(args) {
        created.push(args.data);
        return null;
      },
    };
    const env = createEnvelope({
      eventType: 'trip.completed',
      producer: 'trip-service',
      payload: { tripId: 't1', fareCents: 1500, distanceMeters: 3000, durationSeconds: 1200 },
    });
    await enqueueOutbox({ outboxEvent: delegate }, env, 't1');
    expect(created).toHaveLength(1);
    expect((created[0] as { aggregateId: string }).aggregateId).toBe('t1');
    expect((created[0] as { eventType: string }).eventType).toBe('trip.completed');
  });

  it('PrismaOutboxStore rechaza un schema que no es identificador Postgres (anti-inyección)', () => {
    const noop = { outboxEvent: { create: async () => null } } as unknown as OutboxPrismaClient;
    expect(() => new PrismaOutboxStore(noop, 'rating')).not.toThrow();
    expect(() => new PrismaOutboxStore(noop, 'rating; DROP TABLE x')).toThrow(/schema inválido/);
    expect(() => new PrismaOutboxStore(noop, '1bad')).toThrow(/schema inválido/);
    expect(() => new PrismaOutboxStore(noop, '"quoted"')).toThrow(/schema inválido/);
  });

  it('drain: CLAIM (parametrizado limit+stale) → PUBLISH → ACK marca published los éxitos', async () => {
    const env = createEnvelope({
      eventType: 'rating.created',
      producer: 'rating-service',
      payload: {},
    });
    const claimCalls: { sql: string; values: unknown[] }[] = [];
    const ackCalls: { sql: string; values: unknown[] }[] = [];
    const published: string[] = [];
    const fakePrisma: OutboxPrismaClient = {
      outboxEvent: { create: async () => null },
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]): Promise<T> => {
        claimCalls.push({ sql, values });
        return [
          { id: 'o1', aggregate_id: 'd1', envelope: env, created_at: new Date() },
        ] as T;
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]): Promise<number> => {
        ackCalls.push({ sql, values });
        return 1;
      },
    };
    const store = new PrismaOutboxStore(fakePrisma, 'rating');
    const result = await store.drain(10, 60_000, 8, async (r) => {
      published.push(r.id);
    });

    expect(result.published).toBe(1);
    expect(result.poisoned).toEqual([]);
    expect(published).toEqual(['o1']);
    // CLAIM: el SQL referencia el schema validado e interpola limit+stale como parámetros ($1, $2).
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]!.sql).toContain('"rating"."outbox_events"');
    expect(claimCalls[0]!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimCalls[0]!.values).toEqual([60_000, 10]); // staleMs, limit — NO interpolados como string
    // ACK: marca published los éxitos vía array param.
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]!.sql).toContain('published_at = now()');
    expect(ackCalls[0]!.values).toEqual([['o1']]);
  });

  it('drain: no-op (sin publish ni ack) si el CLAIM no devuelve filas', async () => {
    let acked = false;
    const fakePrisma: OutboxPrismaClient = {
      outboxEvent: { create: async () => null },
      $queryRawUnsafe: async <T>(): Promise<T> => [] as T,
      $executeRawUnsafe: async (): Promise<number> => {
        acked = true;
        return 0;
      },
    };
    const store = new PrismaOutboxStore(fakePrisma, 'rating');
    const published: string[] = [];
    const result = await store.drain(10, 60_000, 8, async (r) => {
      published.push(r.id);
    });
    expect(result.published).toBe(0);
    expect(result.poisoned).toEqual([]);
    expect(published).toEqual([]);
    expect(acked).toBe(false);
  });

  it('drain: un publish que falla → ese id va a fallos (ack resetea claimed_at = NULL, no published)', async () => {
    const env = createEnvelope({ eventType: 'rating.created', producer: 'rating-service', payload: {} });
    const ackCalls: { sql: string; values: unknown[] }[] = [];
    const fakePrisma: OutboxPrismaClient = {
      outboxEvent: { create: async () => null },
      $queryRawUnsafe: async <T>(): Promise<T> =>
        [{ id: 'o1', aggregate_id: 'd1', envelope: env, created_at: new Date() }] as T,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]): Promise<number> => {
        ackCalls.push({ sql, values });
        return 1;
      },
    };
    const store = new PrismaOutboxStore(fakePrisma, 'rating');
    const result = await store.drain(10, 60_000, 8, async () => {
      throw new Error('Kafka caído'); // Error genérico → TRANSITORIO (no poison) → reset claimed_at.
    });
    expect(result.published).toBe(0); // nada publicado OK
    expect(result.poisoned).toEqual([]); // un Error genérico NO es poison permanente
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]!.sql).toContain('claimed_at = NULL'); // reset → retry el próximo tick
    expect(ackCalls[0]!.values).toEqual([['o1']]);
  });

  it('drain: orden per-aggregate — los 3 eventos del MISMO aggregate se publican en orden createdAt', async () => {
    const env = createEnvelope({ eventType: 'rating.created', producer: 'rating-service', payload: {} });
    const t = (s: number) => new Date(2026, 0, 1, 0, 0, s);
    const fakePrisma: OutboxPrismaClient = {
      outboxEvent: { create: async () => null },
      // El claim devuelve YA ordenado por createdAt ASC (ORDER BY del SQL); intercalo aggregates.
      $queryRawUnsafe: async <T>(): Promise<T> =>
        [
          { id: 'a-1', aggregate_id: 'A', envelope: env, created_at: t(1) },
          { id: 'b-1', aggregate_id: 'B', envelope: env, created_at: t(2) },
          { id: 'a-2', aggregate_id: 'A', envelope: env, created_at: t(3) },
          { id: 'a-3', aggregate_id: 'A', envelope: env, created_at: t(4) },
        ] as T,
      $executeRawUnsafe: async (): Promise<number> => 0,
    };
    const store = new PrismaOutboxStore(fakePrisma, 'rating');
    const orderByAgg: Record<string, string[]> = { A: [], B: [] };
    await store.drain(10, 60_000, 8, async (r) => {
      orderByAgg[r.aggregateId]!.push(r.id);
    });
    // Dentro del aggregate A, el orden createdAt se preserva pese a la paralelización entre A y B.
    expect(orderByAgg.A).toEqual(['a-1', 'a-2', 'a-3']);
    expect(orderByAgg.B).toEqual(['b-1']);
  });
});

describe('tombstone (derecho al olvido BR-S06)', () => {
  it('marca deletedAt, anula PII y aplica placeholder en columnas únicas', async () => {
    let captured: Record<string, unknown> = {};
    const delegate: UpdatableDelegate = {
      async update(args) {
        captured = args.data;
        return null;
      },
    };
    await tombstone(delegate, 'u1', {
      piiFields: ['phone', 'email', 'dniHash', 'photoUrl'],
      placeholders: { phone: deletedPlaceholder('u1', 'phone') },
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(captured.deletedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(captured.email).toBeNull();
    expect(captured.dniHash).toBeNull();
    expect(captured.phone).toBe('[deleted:phone:u1]');
  });
});

describe('isUniqueViolation (P2002 estructural, cross-cliente-generado)', () => {
  /** Réplica de cómo el runtime generado de Prisma construye el error (name fijado en el ctor). */
  function prismaError(code: string, target?: unknown): Error {
    const err = new Error('Unique constraint failed') as Error & {
      code: string;
      meta?: { target?: unknown };
    };
    err.name = 'PrismaClientKnownRequestError';
    err.code = code;
    if (target !== undefined) err.meta = { target };
    return err;
  }

  it('matchea P2002 sin columna (cualquier unique)', () => {
    expect(isUniqueViolation(prismaError('P2002'))).toBe(true);
    expect(isUniqueViolation(prismaError('P2002', ['dedupKey']))).toBe(true);
  });

  it('rechaza otros códigos, errores ajenos y no-errores', () => {
    expect(isUniqueViolation(prismaError('P2025'))).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });

  it('con columna: matchea field camelCase, columna snake_case y nombre de constraint', () => {
    expect(isUniqueViolation(prismaError('P2002', ['dedupKey']), 'dedupKey')).toBe(true);
    expect(isUniqueViolation(prismaError('P2002', ['dedup_key']), 'dedupKey')).toBe(true);
    expect(isUniqueViolation(prismaError('P2002', 'panic_events_dedup_key_key'), 'dedupKey')).toBe(
      true,
    );
    expect(isUniqueViolation(prismaError('P2002', ['tripId']), 'dedupKey')).toBe(false);
  });

  it('sin meta.target fiable, asume el unique esperado (no rompe la idempotencia)', () => {
    expect(isUniqueViolation(prismaError('P2002'), 'dedupKey')).toBe(true);
  });
});

describe('isRecordNotFound (P2025 estructural, cross-cliente-generado)', () => {
  function prismaError(code: string): Error {
    const err = new Error('Record to update not found') as Error & { code: string };
    err.name = 'PrismaClientKnownRequestError';
    err.code = code;
    return err;
  }

  it('matchea P2025 (update/delete con where que afecta 0 filas — UPDATE atómico condicionado)', () => {
    expect(isRecordNotFound(prismaError('P2025'))).toBe(true);
  });

  it('rechaza otros códigos, errores ajenos y no-errores', () => {
    expect(isRecordNotFound(prismaError('P2002'))).toBe(false);
    expect(isRecordNotFound(new Error('P2025'))).toBe(false); // name no es PrismaClientKnownRequestError
    expect(isRecordNotFound(null)).toBe(false);
    expect(isRecordNotFound('P2025')).toBe(false);
  });
});
