import { describe, it, expect } from 'vitest';
import { ReadWriteClient, type PrismaLike } from './read-write.js';
import {
  enqueueOutbox,
  PrismaOutboxStore,
  outboxAdvisoryLockKey,
  type OutboxDelegate,
  type OutboxPrismaClient,
} from './outbox.js';
import { tombstone, deletedPlaceholder, type UpdatableDelegate } from './tombstone.js';
import { isUniqueViolation } from './prisma-errors.js';
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
    expect((db.write).connected).toBe(true);
  });

  it('con readUrl distinta, crea cliente de réplica separado y conecta ambos', async () => {
    const db = new ReadWriteClient(FakeClient, {
      writeUrl: 'postgres://primary',
      readUrl: 'postgres://replica',
    });
    expect(db.read).not.toBe(db.write);
    expect((db.read).options?.datasourceUrl).toBe('postgres://replica');
    await db.connect();
    expect((db.read).connected).toBe(true);
    await db.disconnect();
    expect((db.read).connected).toBe(false);
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
      findMany: async () => [],
      updateMany: async () => null,
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

  it('outboxAdvisoryLockKey es estable y distinto por schema', () => {
    expect(outboxAdvisoryLockKey('panic')).toBe(outboxAdvisoryLockKey('panic'));
    expect(outboxAdvisoryLockKey('panic')).not.toBe(outboxAdvisoryLockKey('payment'));
    expect(outboxAdvisoryLockKey('panic') < 9223372036854775807n).toBe(true); // cabe en int8
  });

  it('drainLocked publica los pendientes y los marca (advisory lock adquirido)', async () => {
    const env = createEnvelope({ eventType: 'rating.created', producer: 'rating-service', payload: {} });
    let marked: string[] = [];
    const published: string[] = [];
    const fakePrisma = {
      outboxEvent: {
        create: async () => null,
        findMany: async () => [
          { id: 'o1', aggregateId: 'd1', envelope: env, createdAt: new Date(), publishedAt: null },
        ],
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          marked = args.where.id.in;
          return null;
        },
      },
      $queryRaw: async () => [{ locked: true }],
      $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(fakePrisma),
    };
    const store = new PrismaOutboxStore(fakePrisma as unknown as OutboxPrismaClient, 'rating');
    const n = await store.drainLocked(10, async (r) => {
      published.push(r.id);
    });
    expect(n).toBe(1);
    expect(published).toEqual(['o1']);
    expect(marked).toEqual(['o1']);
  });

  it('drainLocked es no-op (sin leer ni marcar) si otra réplica tiene el advisory lock', async () => {
    let findManyCalled = false;
    const fakePrisma = {
      outboxEvent: {
        create: async () => null,
        findMany: async () => {
          findManyCalled = true;
          return [];
        },
        updateMany: async () => null,
      },
      $queryRaw: async () => [{ locked: false }], // lock NO adquirido (otra réplica drena)
      $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(fakePrisma),
    };
    const store = new PrismaOutboxStore(fakePrisma as unknown as OutboxPrismaClient, 'rating');
    const n = await store.drainLocked(10, async () => undefined);
    expect(n).toBe(0);
    expect(findManyCalled).toBe(false);
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
    const err = new Error('Unique constraint failed') as Error & { code: string; meta?: { target?: unknown } };
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
    expect(isUniqueViolation(prismaError('P2002', 'panic_events_dedup_key_key'), 'dedupKey')).toBe(true);
    expect(isUniqueViolation(prismaError('P2002', ['tripId']), 'dedupKey')).toBe(false);
  });

  it('sin meta.target fiable, asume el unique esperado (no rompe la idempotencia)', () => {
    expect(isUniqueViolation(prismaError('P2002'), 'dedupKey')).toBe(true);
  });
});
