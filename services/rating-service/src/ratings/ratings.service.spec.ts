import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import { RatingsService } from './ratings.service';
import type { TripClient, TripView } from '../trip/trip-client.port';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  ROLLING_WINDOW_DAYS: 30,
  DRIVER_REVIEW_THRESHOLD: 4.3,
  DRIVER_SUSPENSION_THRESHOLD: 4.0,
  PASSENGER_REVERIFY_THRESHOLD: 4.0,
});

/**
 * Fake del TripClient (inyección por token TRIP_CLIENT). Devuelve la vista del viaje configurada (o
 * null = no existe), o LANZA si se pide simular caída de trip-service (fail-closed). Espejo del estilo
 * de mock de prisma: objeto plano que respeta el contrato del puerto, inyectado al constructor.
 */
function makeTripClient(opts: { trip?: TripView | null; throws?: Error } = {}): TripClient {
  return {
    getTrip: async () => {
      if (opts.throws) throw opts.throws;
      return opts.trip ?? null;
    },
  };
}

interface CapturedOutbox {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

interface PrevAggregate {
  flagged: boolean;
  flagReason: string | null;
}

function makePrisma(opts: {
  existingTrip?: boolean;
  windowStars: number[];
  prevAggregate?: PrevAggregate | null;
}) {
  const captured = { outbox: [] as CapturedOutbox[], upserts: [] as Record<string, unknown>[] };
  const tx = {
    rating: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: new Date(),
      }),
      findMany: async () => opts.windowStars.map((stars) => ({ stars })),
    },
    ratingAggregate: {
      findUnique: async () => opts.prevAggregate ?? null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        captured.upserts.push(create);
        return create;
      },
    },
    outboxEvent: {
      create: async ({
        data,
      }: {
        data: {
          aggregateId: string;
          eventType: string;
          envelope: { payload: Record<string, unknown> };
        };
      }) => {
        captured.outbox.push({
          eventType: data.eventType,
          aggregateId: data.aggregateId,
          payload: data.envelope.payload,
        });
        return data;
      },
    },
  };
  const prisma = {
    read: {
      rating: { findUnique: async () => (opts.existingTrip ? { id: 'r0' } : null) },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
  return { prisma, captured };
}

const TRIP = '00000000-0000-0000-0000-0000000000aa';
const RATED = '00000000-0000-0000-0000-0000000000bb';
const RATER = '00000000-0000-0000-0000-0000000000cc';

// Viaje válido por defecto para los caminos felices: COMPLETED, rater = pasajero, ratedId = conductor
// (la contraparte). Reusado por los tests existentes que asumían un trip que pasaba el gate.
const okTripClient = makeTripClient({
  trip: { status: TripStatus.COMPLETED, passengerId: RATER, driverId: RATED },
});

describe('RatingsService.create · un rating por viaje', () => {
  it('rechaza un segundo rating del mismo viaje (ConflictError)', async () => {
    const { prisma } = makePrisma({ existingTrip: true, windowStars: [] });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('crea el rating y publica rating.created con driverId = ratedId', async () => {
    const { prisma, captured } = makePrisma({ existingTrip: false, windowStars: [5] });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    const created = await svc.create(RATER, {
      tripId: TRIP,
      ratedId: RATED,
      ratedRole: 'DRIVER',
      stars: 5,
      comment: 'excelente',
    });
    expect(created.stars).toBe(5);
    const ratingCreated = captured.outbox.find((e) => e.eventType === 'rating.created');
    expect(ratingCreated).toBeDefined();
    expect(ratingCreated?.payload).toMatchObject({ tripId: TRIP, driverId: RATED, stars: 5 });
    // recalculó el agregado (upsert) con el rating recién creado
    expect(captured.upserts).toHaveLength(1);
    expect(Number(captured.upserts[0]?.rollingAvg30d)).toBe(5);
    expect(captured.upserts[0]?.count30d).toBe(1);
    expect(captured.upserts[0]?.flagged).toBe(false);
  });
});

describe('RatingsService.create · gate de validación del viaje (fail-closed)', () => {
  it('rechaza si trip-service no encuentra el viaje (NotFoundError) y NO toca la DB', async () => {
    const { prisma, captured } = makePrisma({ existingTrip: false, windowStars: [] });
    const svc = new RatingsService(prisma as never, config, makeTripClient({ trip: null }));
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Gate antes de la DB: no se creó nada.
    expect(captured.outbox).toHaveLength(0);
    expect(captured.upserts).toHaveLength(0);
  });

  it('rechaza si el viaje NO está COMPLETED (InvalidStateError)', async () => {
    const { prisma } = makePrisma({ existingTrip: false, windowStars: [] });
    const inProgress = makeTripClient({
      trip: { status: TripStatus.IN_PROGRESS, passengerId: RATER, driverId: RATED },
    });
    const svc = new RatingsService(prisma as never, config, inProgress);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rechaza si el rater NO participó del viaje (ForbiddenError)', async () => {
    const { prisma } = makePrisma({ existingTrip: false, windowStars: [] });
    const ALIEN = '00000000-0000-0000-0000-0000000000ee';
    // El viaje es entre OTROS dos; RATER es un tercero ajeno.
    const foreign = makeTripClient({
      trip: { status: TripStatus.COMPLETED, passengerId: ALIEN, driverId: RATED },
    });
    const svc = new RatingsService(prisma as never, config, foreign);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rechaza si el ratedId NO es la contraparte del viaje (ForbiddenError)', async () => {
    const { prisma } = makePrisma({ existingTrip: false, windowStars: [] });
    const OTHER = '00000000-0000-0000-0000-0000000000ff';
    // RATER es el pasajero, el conductor es RATED, pero se intenta calificar a un tercero (OTHER).
    const svc = new RatingsService(
      prisma as never,
      config,
      makeTripClient({
        trip: { status: TripStatus.COMPLETED, passengerId: RATER, driverId: RATED },
      }),
    );
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: OTHER, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el conductor puede calificar al pasajero (contraparte invertida) → crea', async () => {
    const { prisma, captured } = makePrisma({ existingTrip: false, windowStars: [5] });
    // RATER actúa como CONDUCTOR del viaje; la contraparte (ratedId) es el pasajero RATED.
    const driverRates = makeTripClient({
      trip: { status: TripStatus.COMPLETED, passengerId: RATED, driverId: RATER },
    });
    const svc = new RatingsService(prisma as never, config, driverRates);
    const created = await svc.create(RATER, {
      tripId: TRIP,
      ratedId: RATED,
      ratedRole: 'PASSENGER',
      stars: 5,
    });
    expect(created.stars).toBe(5);
    expect(captured.outbox.some((e) => e.eventType === 'rating.created')).toBe(true);
  });

  it('PROPAGA el error si trip-service cae (fail-closed: no se califica a ciegas)', async () => {
    const { prisma, captured } = makePrisma({ existingTrip: false, windowStars: [] });
    const down = makeTripClient({ throws: new Error('trip-service unavailable') });
    const svc = new RatingsService(prisma as never, config, down);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toThrow('trip-service unavailable');
    expect(captured.outbox).toHaveLength(0);
    expect(captured.upserts).toHaveLength(0);
  });
});

describe('RatingsService.create · flags (BR-D01)', () => {
  it('promedio < 4.0 marca conductor y emite driver.flagged suspension', async () => {
    // ventana: [3,3,3] → avg 3.0 < 4.0
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [3, 3, 3],
      prevAggregate: null,
    });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 3 });
    const flagged = captured.outbox.find((e) => e.eventType === 'driver.flagged');
    expect(flagged).toBeDefined();
    expect(flagged?.payload).toMatchObject({
      driverId: RATED,
      reason: 'suspension',
      rollingAvg: 3,
    });
    expect(captured.upserts[0]?.flagged).toBe(true);
    expect(captured.upserts[0]?.flagReason).toBe('suspension');
  });

  it('promedio en banda review (4.2) emite driver.flagged review', async () => {
    // [4,4,4,5] = 17/4 = 4.25 → review
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [4, 4, 4, 5],
      prevAggregate: null,
    });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 4 });
    const flagged = captured.outbox.find((e) => e.eventType === 'driver.flagged');
    expect(flagged?.payload).toMatchObject({ reason: 'review' });
  });

  it('no re-emite el evento si ya estaba flagged con la misma razón', async () => {
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [4, 4, 4, 5], // avg 4.25 → review
      prevAggregate: { flagged: true, flagReason: 'review' },
    });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 4 });
    expect(captured.outbox.some((e) => e.eventType === 'driver.flagged')).toBe(false);
    // pero sigue publicando rating.created
    expect(captured.outbox.some((e) => e.eventType === 'rating.created')).toBe(true);
  });

  it('promedio >= 4.3 no marca al conductor', async () => {
    // [5,5,4,4] = 18/4 = 4.5 ≥ 4.3 → sin flag
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [5, 5, 4, 4],
      prevAggregate: null,
    });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 });
    expect(captured.upserts[0]?.flagged).toBe(false);
  });
});

describe('RatingsService.findByTripForRater · MI rating (anti-IDOR)', () => {
  /** Prisma de lectura: captura el `where` de findFirst y devuelve la fila configurada (o null). */
  function makeReadPrisma(row: Record<string, unknown> | null) {
    const calls: { where: Record<string, unknown> }[] = [];
    const prisma = {
      read: {
        rating: {
          findFirst: async (args: { where: Record<string, unknown> }) => {
            calls.push(args);
            return row;
          },
        },
      },
    };
    return { prisma, calls };
  }

  const ROW = {
    id: 'r1',
    tripId: TRIP,
    raterId: RATER,
    ratedId: RATED,
    stars: 5,
    comment: 'genial',
    createdAt: new Date('2026-06-07T12:00:00.000Z'),
  };

  it('filtra por tripId Y raterId (un ajeno no puede leer el rating de otro)', async () => {
    const { prisma, calls } = makeReadPrisma(ROW);
    const svc = new RatingsService(prisma as never, config, okTripClient);

    const r = await svc.findByTripForRater(TRIP, RATER);

    expect(r?.stars).toBe(5);
    // El WHERE incluye AMBOS: sin el raterId, un pasajero leería el rating de cualquiera de ese viaje.
    expect(calls[0]?.where).toEqual({ tripId: TRIP, raterId: RATER });
  });

  it('devuelve null si ese rater no calificó ese viaje (→ el BFF lo mapea a 404/null)', async () => {
    const { prisma } = makeReadPrisma(null);
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await expect(svc.findByTripForRater(TRIP, RATER)).resolves.toBeNull();
  });

  it('un rater AJENO al rating del viaje obtiene null (no el rating del verdadero rater)', async () => {
    // Simula el DB real: hay un rating (de RATER) pero quien consulta es OTRO → el where por raterId no
    // matchea → findFirst no devuelve fila. Modelamos esa semántica devolviendo null para el ajeno.
    const OTHER = '00000000-0000-0000-0000-0000000000dd';
    const { prisma, calls } = makeReadPrisma(null);
    const svc = new RatingsService(prisma as never, config, okTripClient);

    await expect(svc.findByTripForRater(TRIP, OTHER)).resolves.toBeNull();
    expect(calls[0]?.where).toEqual({ tripId: TRIP, raterId: OTHER });
  });
});

describe('RatingsService.create · flags (BR-I05 pasajero)', () => {
  it('pasajero con promedio < 4.0 emite passenger.flagged reverification', async () => {
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [3, 3],
      prevAggregate: null,
    });
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'PASSENGER', stars: 3 });
    const flagged = captured.outbox.find((e) => e.eventType === 'passenger.flagged');
    expect(flagged).toBeDefined();
    expect(flagged?.payload).toMatchObject({ passengerId: RATED, reason: 'reverification' });
  });

  it('pasajero en banda review de conductor (4.2) NO se marca', async () => {
    const { prisma, captured } = makePrisma({
      existingTrip: false,
      windowStars: [4, 4, 5],
      prevAggregate: null,
    });
    // avg 4.33 ≥ 4.0 → sin flag de pasajero
    const svc = new RatingsService(prisma as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'PASSENGER', stars: 4 });
    expect(captured.outbox.some((e) => e.eventType === 'passenger.flagged')).toBe(false);
  });
});
