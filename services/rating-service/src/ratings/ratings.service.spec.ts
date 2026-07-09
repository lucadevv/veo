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
  MIN_REVIEWS_FOR_SUSPENSION: 10,
  PASSENGER_REVERIFY_THRESHOLD: 4.0,
});

/**
 * Fake del TripClient (inyección por token TRIP_CLIENT). Devuelve la vista del viaje configurada (o
 * null = no existe), o LANZA si se pide simular caída de trip-service (fail-closed). Espejo del estilo
 * de mock del repo: objeto plano que respeta el contrato del puerto, inyectado al constructor.
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
  suspensionSuppressed?: boolean;
}

/**
 * Fake del RatingsRepository (mock del SEAM de acceso a datos, no de Prisma). Al mockear el repo en vez del
 * cliente Prisma, el test aserta sobre métodos PLANOS de dominio (createRating, upsertAggregate,
 * insertOutboxEvent…) en vez de sobre la forma anidada `write.$transaction → tx.rating/ratingAggregate/outbox`.
 * `runInTransaction` ejecuta el `work` con un `tx` ficticio (los métodos tx-scoped lo ignoran y operan sobre el
 * estado capturado).
 */
function makeRepo(opts: {
  existingTrip?: boolean;
  windowStars: number[];
  prevAggregate?: PrevAggregate | null;
}) {
  const captured = {
    outbox: [] as CapturedOutbox[],
    upserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
  };
  const repo = {
    findRatingByTripId: async () => (opts.existingTrip ? { id: 'r0' } : null),
    runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
    createRating: async (_tx: unknown, data: Record<string, unknown>) => ({
      ...data,
      createdAt: new Date(),
    }),
    findWindowRatings: async () => opts.windowStars.map((stars) => ({ stars })),
    findAggregateInTx: async () => opts.prevAggregate ?? null,
    // upsertAggregate captura el `data` de dominio (mismos campos en create-path y cron-path).
    upsertAggregate: async (_tx: unknown, _subjectId: string, data: Record<string, unknown>) => {
      captured.upserts.push(data);
    },
    clearAggregateFlag: async () => {
      captured.updates.push({ flagged: false, flagReason: null, suspensionSuppressed: true });
    },
    insertOutboxEvent: async (
      _tx: unknown,
      aggregateId: string,
      eventType: string,
      envelope: { payload: Record<string, unknown> },
    ) => {
      captured.outbox.push({ eventType, aggregateId, payload: envelope.payload });
    },
  };
  return { repo, captured };
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
    const { repo } = makeRepo({ existingTrip: true, windowStars: [] });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('crea el rating y publica rating.created con driverId = ratedId', async () => {
    const { repo, captured } = makeRepo({ existingTrip: false, windowStars: [5] });
    const svc = new RatingsService(repo as never, config, okTripClient);
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
    const { repo, captured } = makeRepo({ existingTrip: false, windowStars: [] });
    const svc = new RatingsService(repo as never, config, makeTripClient({ trip: null }));
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Gate antes de la DB: no se creó nada.
    expect(captured.outbox).toHaveLength(0);
    expect(captured.upserts).toHaveLength(0);
  });

  it('rechaza si el viaje NO está COMPLETED (InvalidStateError)', async () => {
    const { repo } = makeRepo({ existingTrip: false, windowStars: [] });
    const inProgress = makeTripClient({
      trip: { status: TripStatus.IN_PROGRESS, passengerId: RATER, driverId: RATED },
    });
    const svc = new RatingsService(repo as never, config, inProgress);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rechaza si el rater NO participó del viaje (ForbiddenError)', async () => {
    const { repo } = makeRepo({ existingTrip: false, windowStars: [] });
    const ALIEN = '00000000-0000-0000-0000-0000000000ee';
    // El viaje es entre OTROS dos; RATER es un tercero ajeno.
    const foreign = makeTripClient({
      trip: { status: TripStatus.COMPLETED, passengerId: ALIEN, driverId: RATED },
    });
    const svc = new RatingsService(repo as never, config, foreign);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rechaza si el ratedId NO es la contraparte del viaje (ForbiddenError)', async () => {
    const { repo } = makeRepo({ existingTrip: false, windowStars: [] });
    const OTHER = '00000000-0000-0000-0000-0000000000ff';
    // RATER es el pasajero, el conductor es RATED, pero se intenta calificar a un tercero (OTHER).
    const svc = new RatingsService(
      repo as never,
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
    const { repo, captured } = makeRepo({ existingTrip: false, windowStars: [5] });
    // RATER actúa como CONDUCTOR del viaje; la contraparte (ratedId) es el pasajero RATED.
    const driverRates = makeTripClient({
      trip: { status: TripStatus.COMPLETED, passengerId: RATED, driverId: RATER },
    });
    const svc = new RatingsService(repo as never, config, driverRates);
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
    const { repo, captured } = makeRepo({ existingTrip: false, windowStars: [] });
    const down = makeTripClient({ throws: new Error('trip-service unavailable') });
    const svc = new RatingsService(repo as never, config, down);
    await expect(
      svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 }),
    ).rejects.toThrow('trip-service unavailable');
    expect(captured.outbox).toHaveLength(0);
    expect(captured.upserts).toHaveLength(0);
  });
});

describe('RatingsService.create · flags (BR-D01)', () => {
  it('promedio < 4.0 CON ≥ mínimo de reseñas marca conductor y emite driver.flagged suspension', async () => {
    // ventana de 10 reseñas (= MIN_REVIEWS_FOR_SUSPENSION) en 3.0 → avg 3.0 < 4.0 y count ≥ mínimo → suspension.
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
      prevAggregate: null,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
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

  it('promedio < 4.0 pero MENOS del mínimo de reseñas → NO suspende, CAPA en review (flag de panel)', async () => {
    // ventana de 3 reseñas (< MIN_REVIEWS_FOR_SUSPENSION=10) en 3.0 → avg < 4.0 pero count insuficiente.
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [3, 3, 3],
      prevAggregate: null,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 3 });
    const flagged = captured.outbox.find((e) => e.eventType === 'driver.flagged');
    expect(flagged).toBeDefined();
    // El payload lleva 'review', NO 'suspension': identity NO auto-suspende con pocas reseñas.
    expect(flagged?.payload).toMatchObject({ driverId: RATED, reason: 'review' });
    expect(captured.upserts[0]?.flagged).toBe(true);
    expect(captured.upserts[0]?.flagReason).toBe('review');
  });

  it('promedio en banda review (4.2) emite driver.flagged review', async () => {
    // [4,4,4,5] = 17/4 = 4.25 → review
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [4, 4, 4, 5],
      prevAggregate: null,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 4 });
    const flagged = captured.outbox.find((e) => e.eventType === 'driver.flagged');
    expect(flagged?.payload).toMatchObject({ reason: 'review' });
  });

  it('no re-emite el evento si ya estaba flagged con la misma razón', async () => {
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [4, 4, 4, 5], // avg 4.25 → review
      prevAggregate: { flagged: true, flagReason: 'review' },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 4 });
    expect(captured.outbox.some((e) => e.eventType === 'driver.flagged')).toBe(false);
    // pero sigue publicando rating.created
    expect(captured.outbox.some((e) => e.eventType === 'rating.created')).toBe(true);
  });

  it('promedio >= 4.3 no marca al conductor', async () => {
    // [5,5,4,4] = 18/4 = 4.5 ≥ 4.3 → sin flag
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [5, 5, 4, 4],
      prevAggregate: null,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 });
    expect(captured.upserts[0]?.flagged).toBe(false);
  });

  it('RE-SUSPENSIÓN tras override: limpiado el sticky (prev limpio), una nueva reseña mala (<4.0, ≥min) RE-emite suspension', async () => {
    // Estado tras `clearRatingFlag` (override de identity levantó el hold): el agregado quedó LIMPIO. El
    // rating SIGUE malo (las reseñas no cambiaron). Una nueva reseña mala recomputa 'suspension', y como
    // prev quedó limpio → isNewFlag vuelve a ser true → SE RE-EMITE (período de gracia, no inmunidad eterna).
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], // 10 reseñas (≥ min) avg 3.0 < 4.0 → suspension
      prevAggregate: { flagged: false, flagReason: null }, // ← el sticky YA fue limpiado por el override
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 3 });
    const flagged = captured.outbox.find((e) => e.eventType === 'driver.flagged');
    expect(flagged).toBeDefined();
    expect(flagged?.payload).toMatchObject({ driverId: RATED, reason: 'suspension' });
  });
});

describe('RatingsService.findByTripForRater · MI rating (anti-IDOR)', () => {
  /** Repo de lectura: captura los args de findRatingByTripAndRater y devuelve la fila configurada (o null). */
  function makeReadRepo(row: Record<string, unknown> | null) {
    const calls: { tripId: string; raterId: string }[] = [];
    const repo = {
      findRatingByTripAndRater: async (tripId: string, raterId: string) => {
        calls.push({ tripId, raterId });
        return row;
      },
    };
    return { repo, calls };
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
    const { repo, calls } = makeReadRepo(ROW);
    const svc = new RatingsService(repo as never, config, okTripClient);

    const r = await svc.findByTripForRater(TRIP, RATER);

    expect(r?.stars).toBe(5);
    // El acceso incluye AMBOS: sin el raterId, un pasajero leería el rating de cualquiera de ese viaje.
    expect(calls[0]).toEqual({ tripId: TRIP, raterId: RATER });
  });

  it('devuelve null si ese rater no calificó ese viaje (→ el BFF lo mapea a 404/null)', async () => {
    const { repo } = makeReadRepo(null);
    const svc = new RatingsService(repo as never, config, okTripClient);
    await expect(svc.findByTripForRater(TRIP, RATER)).resolves.toBeNull();
  });

  it('un rater AJENO al rating del viaje obtiene null (no el rating del verdadero rater)', async () => {
    // Simula el DB real: hay un rating (de RATER) pero quien consulta es OTRO → el filtro por raterId no
    // matchea → findRatingByTripAndRater no devuelve fila. Modelamos esa semántica devolviendo null.
    const OTHER = '00000000-0000-0000-0000-0000000000dd';
    const { repo, calls } = makeReadRepo(null);
    const svc = new RatingsService(repo as never, config, okTripClient);

    await expect(svc.findByTripForRater(TRIP, OTHER)).resolves.toBeNull();
    expect(calls[0]).toEqual({ tripId: TRIP, raterId: OTHER });
  });
});

describe('RatingsService.create · flags (BR-I05 pasajero)', () => {
  it('pasajero con promedio < 4.0 emite passenger.flagged reverification', async () => {
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [3, 3],
      prevAggregate: null,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'PASSENGER', stars: 3 });
    const flagged = captured.outbox.find((e) => e.eventType === 'passenger.flagged');
    expect(flagged).toBeDefined();
    expect(flagged?.payload).toMatchObject({ passengerId: RATED, reason: 'reverification' });
  });

  it('pasajero en banda review de conductor (4.2) NO se marca', async () => {
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: [4, 4, 5],
      prevAggregate: null,
    });
    // avg 4.33 ≥ 4.0 → sin flag de pasajero
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'PASSENGER', stars: 4 });
    expect(captured.outbox.some((e) => e.eventType === 'passenger.flagged')).toBe(false);
  });
});

/**
 * Repo minimal para clearRatingFlag: solo necesita findAggregateInTx + clearAggregateFlag dentro de la tx.
 * Captura los `update` para aseverar QUÉ se limpió (y que NO se llamó cuando es no-op / guard).
 */
function makeClearRepo(prevAggregate: PrevAggregate | null) {
  const captured = { updates: [] as Record<string, unknown>[] };
  const repo = {
    runInTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
    findAggregateInTx: async () => prevAggregate,
    clearAggregateFlag: async () => {
      captured.updates.push({ flagged: false, flagReason: null, suspensionSuppressed: true });
    },
  };
  return { repo, captured };
}

const DRIVER = '00000000-0000-0000-0000-0000000000dd';

describe('RatingsService.clearRatingFlag · limpia el sticky + activa la gracia tras driver.reactivated', () => {
  it('limpia flagged+flagReason Y ACTIVA suspensionSuppressed cuando estaba flageado como suspension', async () => {
    const { repo, captured } = makeClearRepo({ flagged: true, flagReason: 'suspension' });
    const svc = new RatingsService(repo as never, config, okTripClient);
    const cleared = await svc.clearRatingFlag(DRIVER);
    expect(cleared).toBe(true);
    expect(captured.updates).toHaveLength(1);
    // Limpia el sticky Y prende la supresión: el cron ya no podrá re-escalar a 'suspension' (período de gracia).
    expect(captured.updates[0]).toMatchObject({
      flagged: false,
      flagReason: null,
      suspensionSuppressed: true,
    });
  });

  it('agregado ya limpio PERO sin supresión → ACTIVA la gracia (escribe): re-override re-arma la gracia', async () => {
    // Caso real: un override sobre un conductor que ya no estaba flageado igual debe prender la gracia, para que
    // un cron posterior (si el avg sigue malo) no lo re-suspenda hasta la próxima reseña.
    const { repo, captured } = makeClearRepo({
      flagged: false,
      flagReason: null,
      suspensionSuppressed: false,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    const cleared = await svc.clearRatingFlag(DRIVER);
    expect(cleared).toBe(true);
    expect(captured.updates[0]).toMatchObject({ suspensionSuppressed: true });
  });

  it('IDEMPOTENTE: ya limpio Y ya suprimido → no-op, no escribe', async () => {
    const { repo, captured } = makeClearRepo({
      flagged: false,
      flagReason: null,
      suspensionSuppressed: true,
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    const cleared = await svc.clearRatingFlag(DRIVER);
    expect(cleared).toBe(false);
    expect(captured.updates).toHaveLength(0);
  });

  it('GUARD: sin agregado para ese conductor → no-op, no crashea ni escribe', async () => {
    const { repo, captured } = makeClearRepo(null);
    const svc = new RatingsService(repo as never, config, okTripClient);
    const cleared = await svc.clearRatingFlag(DRIVER);
    expect(cleared).toBe(false);
    expect(captured.updates).toHaveLength(0);
  });
});

describe('RatingsService · período de gracia post-override (FIX cron re-suspende sin reseña nueva)', () => {
  const BAD_WINDOW = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]; // 10 reseñas (≥ min) avg 3.0 < 4.0 → decisión cruda 'suspension'
  const GOOD_WINDOW = [5, 5, 4, 4]; // avg 4.5 ≥ 4.3 → sin flag

  it('CRON con gracia activa NO re-emite suspension sobre las MISMAS reseñas viejas (override respetado)', async () => {
    // Estado tras el override: sticky limpio + suspensionSuppressed=true. El cron recomputa el MISMO avg malo.
    const { repo, captured } = makeRepo({
      windowStars: BAD_WINDOW,
      prevAggregate: { flagged: false, flagReason: null, suspensionSuppressed: true },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.recomputeAggregate(RATED, 'DRIVER', new Date(), 'cron');
    // NO se re-emite 'driver.flagged' suspension: la gracia degrada la decisión del cron a 'review'.
    const suspension = captured.outbox.find(
      (e) => e.eventType === 'driver.flagged' && e.payload.reason === 'suspension',
    );
    expect(suspension).toBeUndefined();
    // El agregado NO queda en 'suspension' y la supresión PERSISTE (sigue true hasta una reseña nueva).
    expect(captured.upserts[0]?.flagReason).not.toBe('suspension');
    expect(captured.upserts[0]?.suspensionSuppressed).toBe(true);
  });

  it('CRON SIN gracia (supresión false) SÍ escala a suspension (comportamiento normal del barrido)', async () => {
    const { repo, captured } = makeRepo({
      windowStars: BAD_WINDOW,
      prevAggregate: { flagged: false, flagReason: null, suspensionSuppressed: false },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.recomputeAggregate(RATED, 'DRIVER', new Date(), 'cron');
    const suspension = captured.outbox.find(
      (e) => e.eventType === 'driver.flagged' && e.payload.reason === 'suspension',
    );
    expect(suspension).toBeDefined();
  });

  it('RESEÑA NUEVA mala (avg<4.0, ≥min) bajo gracia LIMPIA la supresión y RE-emite suspension → re-suspende', async () => {
    // create() recomputa con source='review': limpia la gracia y re-evalúa. prev limpio → isNewFlag → re-emite.
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: BAD_WINDOW,
      prevAggregate: { flagged: false, flagReason: null, suspensionSuppressed: true },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 3 });
    const suspension = captured.outbox.find(
      (e) => e.eventType === 'driver.flagged' && e.payload.reason === 'suspension',
    );
    expect(suspension).toBeDefined();
    // La reseña nueva LIMPIA la supresión (suspensionSuppressed=false): la gracia se consumió.
    expect(captured.upserts[0]?.suspensionSuppressed).toBe(false);
  });

  it('RESEÑA NUEVA buena (avg≥4.0) bajo gracia deja al conductor ACTIVO (sin flag) y limpia la supresión', async () => {
    const { repo, captured } = makeRepo({
      existingTrip: false,
      windowStars: GOOD_WINDOW,
      prevAggregate: { flagged: false, flagReason: null, suspensionSuppressed: true },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.create(RATER, { tripId: TRIP, ratedId: RATED, ratedRole: 'DRIVER', stars: 5 });
    // Sin flag (avg ≥ 4.3) y sin emitir suspension: el conductor queda activo.
    expect(captured.upserts[0]?.flagged).toBe(false);
    expect(captured.outbox.some((e) => e.eventType === 'driver.flagged')).toBe(false);
    expect(captured.upserts[0]?.suspensionSuppressed).toBe(false);
  });

  it('IDEMPOTENTE: dos pasadas de CRON bajo gracia → ninguna re-emite suspension (no escalada repetida)', async () => {
    const { repo, captured } = makeRepo({
      windowStars: BAD_WINDOW,
      prevAggregate: { flagged: true, flagReason: 'review', suspensionSuppressed: true },
    });
    const svc = new RatingsService(repo as never, config, okTripClient);
    await svc.recomputeAggregate(RATED, 'DRIVER', new Date(), 'cron');
    await svc.recomputeAggregate(RATED, 'DRIVER', new Date(), 'cron');
    expect(
      captured.outbox.filter(
        (e) => e.eventType === 'driver.flagged' && e.payload.reason === 'suspension',
      ),
    ).toHaveLength(0);
  });
});
