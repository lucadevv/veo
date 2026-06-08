import { describe, it, expect } from 'vitest';
import { ReadWriteClient, type PrismaLike } from './read-write.js';
import { enqueueOutbox, PrismaOutboxStore, type OutboxDelegate } from './outbox.js';
import { tombstone, deletedPlaceholder, type UpdatableDelegate } from './tombstone.js';
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

  it('PrismaOutboxStore drena pendientes y los marca publicados', async () => {
    const env = createEnvelope({ eventType: 'rating.created', producer: 'rating-service', payload: {} });
    let marked: string[] = [];
    const delegate: OutboxDelegate = {
      create: async () => null,
      findMany: async () => [
        { id: 'o1', aggregateId: 'd1', envelope: env, createdAt: new Date(), publishedAt: null },
      ],
      async updateMany(args) {
        marked = args.where.id.in;
        return null;
      },
    };
    const store = new PrismaOutboxStore(delegate);
    const pending = await store.fetchUnpublished(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.aggregateId).toBe('d1');
    await store.markPublished(pending.map((p) => p.id));
    expect(marked).toEqual(['o1']);
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
