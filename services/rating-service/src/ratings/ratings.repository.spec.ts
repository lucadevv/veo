import { describe, it, expect, vi } from 'vitest';
import { RatingsRepository, type AggregateWrite } from './ratings.repository';
import type { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

const SUBJECT = '00000000-0000-0000-0000-0000000000bb';
const TRIP = '00000000-0000-0000-0000-0000000000aa';
const RATER = '00000000-0000-0000-0000-0000000000cc';

/**
 * Espeja el estilo de `bookings.repository.spec.ts`: se mockea el cliente Prisma (read/write split) y se
 * asevera CÓMO el repo construye las queries — el service ya no las ve. Cubre las decisiones que el repo
 * OWNea: filtros anti-IDOR, la ventana rolling (createdAt ≥ cutoff), el mapeo número→Decimal del agregado y
 * el outbox-en-transacción.
 */

describe('RatingsRepository · lecturas (réplica)', () => {
  it('findRatingByTripAndRater filtra por tripId Y raterId (seam anti-IDOR)', async () => {
    const readFindFirst = vi.fn(async () => null);
    const prisma = {
      read: { rating: { findFirst: readFindFirst } },
    } as unknown as PrismaService;

    const repo = new RatingsRepository(prisma);
    await repo.findRatingByTripAndRater(TRIP, RATER);

    // Sin el raterId, un pasajero leería el rating de cualquiera de ese viaje.
    expect(readFindFirst).toHaveBeenCalledWith({ where: { tripId: TRIP, raterId: RATER } });
  });

  it('listAggregateSubjects lee de la réplica sólo subjectId + role (input del barrido)', async () => {
    const readFindMany = vi.fn(async () => [{ subjectId: SUBJECT, role: 'DRIVER' }]);
    const prisma = {
      read: { ratingAggregate: { findMany: readFindMany } },
    } as unknown as PrismaService;

    const repo = new RatingsRepository(prisma);
    const subjects = await repo.listAggregateSubjects();

    expect(subjects).toEqual([{ subjectId: SUBJECT, role: 'DRIVER' }]);
    expect(readFindMany).toHaveBeenCalledWith({ select: { subjectId: true, role: true } });
  });
});

describe('RatingsRepository · transacción (primary)', () => {
  it('runInTransaction delega en prisma.write.$transaction y devuelve el resultado del work', async () => {
    const tx = { marker: 'tx' };
    const $transaction = vi.fn(async (work: (t: typeof tx) => unknown) => work(tx));
    const prisma = { write: { $transaction } } as unknown as PrismaService;

    const repo = new RatingsRepository(prisma);
    const result = await repo.runInTransaction(async (t) => {
      expect(t).toBe(tx as never);
      return 42;
    });

    expect(result).toBe(42);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('findWindowRatings arma la ventana rolling (ratedId + createdAt ≥ cutoff) y sólo trae stars', async () => {
    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const findMany = vi.fn(async () => [{ stars: 5 }, { stars: 4 }]);
    const tx = { rating: { findMany } } as never;

    const repo = new RatingsRepository({} as unknown as PrismaService);
    const rows = await repo.findWindowRatings(tx, SUBJECT, cutoff);

    expect(rows).toEqual([{ stars: 5 }, { stars: 4 }]);
    expect(findMany).toHaveBeenCalledWith({
      where: { ratedId: SUBJECT, createdAt: { gte: cutoff } },
      select: { stars: true },
    });
  });

  it('upsertAggregate MAPEA el avg de dominio (número) a Prisma.Decimal en create y update', async () => {
    let arg!: {
      where: { subjectId: string };
      create: { subjectId: string; rollingAvg30d: unknown };
      update: { rollingAvg30d: unknown };
    };
    const upsert = vi.fn(async (a: typeof arg) => {
      arg = a;
      return {};
    });
    const tx = { ratingAggregate: { upsert } } as never;

    const data: AggregateWrite = {
      role: 'DRIVER',
      rollingAvg30d: 4.25,
      count30d: 4,
      flagged: true,
      flagReason: 'review',
      suspensionSuppressed: false,
      lastComputedAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const repo = new RatingsRepository({} as unknown as PrismaService);
    await repo.upsertAggregate(tx, SUBJECT, data);

    expect(arg.where).toEqual({ subjectId: SUBJECT });
    // El repo (no el service) convierte a Decimal: la columna es Decimal(3,2).
    expect(arg.create.rollingAvg30d).toBeInstanceOf(Prisma.Decimal);
    expect(arg.update.rollingAvg30d).toBeInstanceOf(Prisma.Decimal);
    expect(Number(arg.create.rollingAvg30d)).toBe(4.25);
    expect(arg.create.subjectId).toBe(SUBJECT);
  });

  it('clearAggregateFlag limpia el sticky y ACTIVA la supresión (período de gracia)', async () => {
    const update = vi.fn(async () => ({}));
    const tx = { ratingAggregate: { update } } as never;

    const repo = new RatingsRepository({} as unknown as PrismaService);
    await repo.clearAggregateFlag(tx, SUBJECT);

    expect(update).toHaveBeenCalledWith({
      where: { subjectId: SUBJECT },
      data: { flagged: false, flagReason: null, suspensionSuppressed: true },
    });
  });

  it('insertOutboxEvent persiste el envelope en la MISMA tx (outbox-en-transacción)', async () => {
    const create = vi.fn(async () => ({}));
    const tx = { outboxEvent: { create } } as never;
    const envelope = { eventType: 'rating.created', payload: { ratingId: 'r1' } };

    const repo = new RatingsRepository({} as unknown as PrismaService);
    await repo.insertOutboxEvent(tx, SUBJECT, 'rating.created', envelope);

    expect(create).toHaveBeenCalledWith({
      data: { aggregateId: SUBJECT, eventType: 'rating.created', envelope },
    });
  });
});
